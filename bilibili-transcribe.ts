/**
 * opencli-plugin-transcribe: bilibili transcribe command
 *
 * Subtitle-first (WBI-signed API via browser fetch), Whisper large-v3 fallback.
 * Reference: src/clis/bilibili/subtitle.ts, src/clis/bilibili/utils.ts (2026-04-01)
 *
 * Bilibili subtitle flow:
 *   page.goto(videoUrl)
 *   → page.evaluate: extract __INITIAL_STATE__.videoData.cid
 *   → page.evaluate: fetch /x/web-interface/nav → WBI keys (imgKey/subKey)
 *   → Node: getMixinKey + MD5 → signed params
 *   → page.evaluate: fetch /x/player/wbi/v2?<signed> → subtitle list
 *   → page.evaluate: fetch subtitleUrl → subtitle JSON
 */

import { createHash } from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { TranscribeError } from './_errors.js';
import { downloadAudio } from './_download.js';
import { transcribeWithWhisper } from './_whisper.js';
import { formatRaw, formatGrouped, type Segment } from './_format.js';
import { createTempDir, cleanupTempDir, registerCleanupHook } from './_temp.js';
import { langMap } from './_lang-map.js';
import type { IPage } from '@jackwener/opencli/registry';

// WBI mixin key encoding table (from bilibili/utils.ts, 2026-04-01)
const MIXIN_KEY_ENC_TAB = [
  46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
  33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,
  61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,
  36,20,34,44,52,
];

cli({
  site: 'bilibili',
  name: 'transcribe',
  description: '转录 Bilibili 视频（字幕优先，无字幕时 Whisper large-v3 兜底）',
  domain: 'www.bilibili.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'url', required: true, positional: true, help: 'Bilibili 视频 URL 或 BVID (如 BV1xxxxxx)' },
    { name: 'lang', required: false, help: '字幕语言代码 (如 zh-CN, en-US)' },
    { name: 'mode', required: false, default: 'grouped', choices: ['grouped', 'raw'], help: '输出模式：grouped 或 raw' },
    { name: 'force-asr', required: false, type: 'boolean', default: false, help: '跳过字幕，直接使用 Whisper' },
    { name: 'keep-audio', required: false, type: 'boolean', default: false, help: '保留临时音频文件' },
  ],
  func: async (page, kwargs) => {
    const inputUrl = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : '';
    const mode = String(kwargs.mode || 'grouped');
    const forceAsr = Boolean(kwargs['force-asr']);
    const keepAudio = Boolean(kwargs['keep-audio']);

    const videoUrl = normalizeBilibiliUrl(inputUrl);
    const whisperLang = lang ? langMap(lang) : undefined;

    // ── Step 1: Try platform subtitles (unless --force-asr) ──────────────────
    if (!forceAsr && page) {
      try {
        const result = await fetchBilibiliSubtitle(page, videoUrl, inputUrl, lang);
        if (result !== null) {
          const { segments, source } = result;
          return mode === 'raw'
            ? formatRaw(segments, source)
            : formatGrouped(segments, source);
        }
      } catch (err) {
        // Non-fatal: log and fall through to Whisper
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: subtitle fetch failed (${msg}), falling back to Whisper`);
      }
    }

    // ── Step 2: Whisper fallback ─────────────────────────────────────────────
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);

    try {
      const audioPath = await downloadAudio(videoUrl, tempDir);
      const segments = await transcribeWithWhisper(audioPath, tempDir, whisperLang);

      if (segments.length === 0) {
        throw new TranscribeError('Whisper 没有返回任何片段，音频可能过短或无声。');
      }

      return mode === 'raw'
        ? formatRaw(segments, 'whisper_large_v3')
        : formatGrouped(segments, 'whisper_large_v3');
    } finally {
      deregister();
      cleanupTempDir(tempDir, keepAudio);
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Accept BVID (BV...) or full URL; always return a full bilibili video URL */
export function normalizeBilibiliUrl(input: string): string {
  if (input.startsWith('http')) return input;
  // Validate BVID format: BV followed by alphanumeric chars
  if (/^BV[a-zA-Z0-9]+$/.test(input)) {
    return `https://www.bilibili.com/video/${input}`;
  }
  // Try it anyway
  return `https://www.bilibili.com/video/${input}`;
}

interface SubtitleResult {
  segments: Segment[];
  source: 'manual_caption' | 'auto_caption';
}

async function fetchBilibiliSubtitle(
  page: IPage,
  videoUrl: string,
  originalInput: string,
  lang: string,
): Promise<SubtitleResult | null> {
  // Navigate to video page
  await page.goto(videoUrl);

  // Extract CID from __INITIAL_STATE__
  const cid = await page.evaluate(`(async () => {
    const state = window.__INITIAL_STATE__ || {};
    return state?.videoData?.cid;
  })()`);

  if (!cid) {
    throw new TranscribeError('无法从页面提取 CID，请检查视频页面是否正常加载。如页面结构已变化，请更新插件。');
  }

  // Extract BVID from URL or input for API call
  const bvid = extractBvid(originalInput) || extractBvid(videoUrl) || originalInput;

  // Get WBI keys from nav API (via browser fetch, auto-carries cookies)
  const navData = await page.evaluate(`(async () => {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    return await res.json();
  })()`);

  const wbiImg = navData?.data?.wbi_img ?? {};
  const imgKey = (wbiImg.img_url ?? '').split('/').pop()?.split('.')[0] ?? '';
  const subKey = (wbiImg.sub_url ?? '').split('/').pop()?.split('.')[0] ?? '';

  // Node-side WBI signing
  const signedParams = await wbiSign({ bvid, cid: String(cid) }, imgKey, subKey);

  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(signedParams).map(([k, v]) => [k, String(v)])),
  ).toString().replace(/\+/g, '%20');

  const apiUrl = `https://api.bilibili.com/x/player/wbi/v2?${qs}`;

  // Fetch subtitle list via browser (auto-carries cookies)
  const payload = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include' });
    return await res.json();
  })()`);

  if (payload?.code !== 0) {
    throw new TranscribeError(`获取字幕列表失败: ${payload?.message ?? 'unknown'} (${payload?.code ?? '?'})`);
  }

  const needLogin = payload?.data?.need_login_subtitle === true;
  const subtitles: Array<{ lan: string; subtitle_url: string; lan_doc?: string }> = payload?.data?.subtitle?.subtitles ?? [];

  if (subtitles.length === 0) {
    if (needLogin) {
      console.error('Warning: 此视频字幕需要登录才能访问，fallback 到 Whisper ASR');
    }
    return null;
  }

  // Select track by language
  let target = subtitles[0];
  if (lang) {
    const matched = subtitles.find(s => s.lan === lang) ?? subtitles[0];
    if (matched.lan !== lang) {
      console.error(`Warning: --lang "${lang}" 未找到，使用 "${matched.lan}"。可用: ${subtitles.map(s => s.lan).join(', ')}`);
    }
    target = matched;
  }

  const subtitleUrl = target.subtitle_url;
  if (!subtitleUrl) {
    console.error('Warning: subtitle_url 为空，可能需要登录或风控，fallback 到 Whisper');
    return null;
  }
  const finalUrl = subtitleUrl.startsWith('//') ? 'https:' + subtitleUrl : subtitleUrl;

  // Fetch subtitle JSON via browser
  const subResult = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(finalUrl)});
    const text = await res.text();
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      return { error: 'HTML_RESPONSE' };
    }
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.body)) return { data: j.body };
      if (Array.isArray(j)) return { data: j };
      return { error: 'UNKNOWN_FORMAT' };
    } catch { return { error: 'PARSE_FAILED' }; }
  })()`);

  if (subResult?.error) {
    throw new TranscribeError(`字幕 JSON 获取失败: ${subResult.error}`);
  }

  const rawItems: Array<{ from: number; to: number; content: string }> = subResult?.data ?? [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }

  // Normalize Bilibili fields (from/to/content → start/end/text)
  const segments: Segment[] = rawItems.map(item => ({
    start: Number(item.from ?? 0),
    end: Number(item.to ?? 0),
    text: String(item.content ?? ''),
  }));

  // Determine source: Bilibili AI subtitles have lan starting with "ai-"
  const source: 'manual_caption' | 'auto_caption' = target.lan?.startsWith('ai-') ? 'auto_caption' : 'manual_caption';

  return { segments, source };
}

function extractBvid(input: string): string | null {
  const match = input.match(/BV[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}

function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map(i => raw[i] || '').join('').slice(0, 32);
}

async function wbiSign(
  params: Record<string, string>,
  imgKey: string,
  subKey: string,
): Promise<Record<string, string>> {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const allParams: Record<string, string> = { ...params, wts: String(wts) };
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, '');
  }
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  const wRid = createHash('md5').update(query + mixinKey).digest('hex');
  sorted.w_rid = wRid;
  return sorted;
}
