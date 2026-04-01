/**
 * opencli-plugin-transcribe: youtube transcribe command
 *
 * Subtitle-first (yt-dlp subtitle download), Whisper large-v3 fallback.
 * Reference: src/clis/youtube/transcript.ts (2026-04-01)
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { TranscribeError } from './_errors.js';
import { downloadAudio, downloadAudioFromUrl } from './_download.js';
import { transcribeWithWhisper } from './_whisper.js';
import { formatRaw, formatGrouped, type Segment } from './_format.js';
import { createTempDir, cleanupTempDir, registerCleanupHook } from './_temp.js';
import { langMap } from './_lang-map.js';

cli({
  site: 'youtube',
  name: 'transcribe',
  description: 'Transcribe a YouTube video (subtitles first, Whisper large-v3 fallback)',
  domain: 'www.youtube.com',
  strategy: Strategy.COOKIE,
  timeoutSeconds: 25200, // 7 hours — Whisper large-v3 on long videos can take a while
  args: [
    { name: 'url', required: true, positional: true, help: 'YouTube video URL or video ID' },
    { name: 'lang', required: false, help: 'Language code (e.g. en, zh-Hans). Omit to auto-select' },
    { name: 'mode', required: false, default: 'raw', choices: ['raw', 'grouped'], help: 'Output mode: raw (per-segment with timestamps) or grouped (merged paragraphs)' },
    { name: 'force-asr', required: false, type: 'boolean', default: false, help: 'Skip subtitles and always use Whisper' },
    { name: 'keep-audio', required: false, type: 'boolean', default: false, help: 'Keep temporary audio file after transcription' },
  ],
  func: async (page, kwargs) => {
    const url = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : '';
    const mode = String(kwargs.mode || 'raw');
    const forceAsr = Boolean(kwargs['force-asr']);
    const keepAudio = Boolean(kwargs['keep-audio']);

    const videoId = parseVideoId(url);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const whisperLang = lang ? langMap(lang) : undefined;
    let ytAudioUrl: string | null = null;

    // ── Step 1: Try subtitles via yt-dlp (unless --force-asr) ───────────────
    if (!forceAsr) {
      // First, extract audio URL from page if browser is available
      if (page) {
        try {
          await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
          const audioData = await page.evaluate(`
            (() => {
              const data = window.ytInitialPlayerResponse;
              if (!data) return null;
              const formats = data.streamingData?.adaptiveFormats ?? [];
              const audioFmt = formats.find(f => f.itag === 140 && f.url)
                || formats.find(f => f.mimeType?.startsWith('audio/') && f.url);
              return audioFmt?.url ?? null;
            })()
          `);
          if (audioData) ytAudioUrl = audioData;
        } catch {
          // Non-fatal: we just won't have the streaming URL
        }
      }

      // Download subtitles via yt-dlp
      console.error('[transcribe] Checking for subtitles via yt-dlp...');
      const tempDir = createTempDir();
      try {
        const result = await downloadSubtitlesViaYtDlp(videoUrl, tempDir, lang);
        if (result && result.segments.length > 0) {
          const source = result.isAuto ? 'auto_caption' : 'manual_caption';
          cleanupTempDir(tempDir, false);
          return mode === 'raw'
            ? formatRaw(result.segments, source)
            : formatGrouped(result.segments, source);
        }
        cleanupTempDir(tempDir, false);
      } catch (err) {
        cleanupTempDir(tempDir, false);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[transcribe] Subtitle download failed: ${msg}`);
      }
    }

    // ── Step 2: Whisper fallback ─────────────────────────────────────────────
    console.error('[transcribe] No subtitles found. Falling back to Whisper large-v3 ASR...');
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);

    try {
      if (ytAudioUrl) {
        console.error('[transcribe] Downloading audio via streaming URL...');
      } else {
        console.error('[transcribe] Downloading audio via yt-dlp...');
      }
      const audioPath = ytAudioUrl
        ? await downloadAudioFromUrl(ytAudioUrl, tempDir)
        : await downloadAudio(url, tempDir);
      console.error('[transcribe] Audio ready. Starting Whisper transcription (this may take several minutes)...');
      const segments = await transcribeWithWhisper(audioPath, tempDir, whisperLang);

      if (segments.length === 0) {
        throw new TranscribeError('Whisper returned no segments. The audio may be too short or silent.');
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

export function parseVideoId(input: string): string {
  if (!input.startsWith('http')) return input;
  try {
    const parsed = new URL(input);
    if (parsed.searchParams.has('v')) return parsed.searchParams.get('v')!;
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).split('/')[0];
    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
    if (pathMatch) return pathMatch[2];
  } catch { /* treat as video ID */ }
  return input;
}

interface SubtitleResult {
  segments: Segment[];
  isAuto: boolean;
}

/**
 * Download subtitles using yt-dlp and parse the json3 output.
 * Tries manual subtitles first, then auto-generated.
 */
async function downloadSubtitlesViaYtDlp(
  videoUrl: string,
  outputDir: string,
  lang: string,
): Promise<SubtitleResult | null> {
  const outputTemplate = path.join(outputDir, 'sub');

  // Try manual subtitles first
  const subLang = lang || 'zh,en,ja,ko';
  try {
    await runYtDlpSubDownload(videoUrl, outputTemplate, subLang, false);
    const segments = findAndParseSubFile(outputDir);
    if (segments) {
      console.error('[transcribe] Found manual subtitles');
      return { segments, isAuto: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[transcribe] Manual subtitle download failed: ${msg}`);
  }

  // Try auto-generated subtitles
  try {
    await runYtDlpSubDownload(videoUrl, outputTemplate, subLang, true);
    const segments = findAndParseSubFile(outputDir);
    if (segments) {
      console.error('[transcribe] Found auto-generated subtitles');
      return { segments, isAuto: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[transcribe] Auto subtitle download failed: ${msg}`);
  }

  return null;
}

function runYtDlpSubDownload(
  videoUrl: string,
  outputTemplate: string,
  subLang: string,
  autoSub: boolean,
): Promise<void> {
  const args = [
    '--skip-download',
    '--no-playlist',
    '--sub-format', 'json3',
    '-o', outputTemplate,
    '--cookies-from-browser', 'chrome',
    '--remote-components', 'ejs:github',
  ];

  if (autoSub) {
    args.push('--write-auto-sub', '--sub-lang', subLang);
  } else {
    args.push('--write-sub', '--sub-lang', subLang);
  }

  args.push(videoUrl);

  return new Promise((resolve, reject) => {
    let stderr = '';
    execFile(
      'yt-dlp',
      args,
      {
        timeout: 60_000,
        env: {
          ...process.env,
          DESKTOP_SESSION: process.env.DESKTOP_SESSION || 'gnome',
        },
      },
      (err) => {
        if (err) {
          reject(new TranscribeError(`yt-dlp subtitle download failed: ${stderr.trim() || err.message}`));
        } else {
          resolve();
        }
      },
    ).stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
  });
}

function findAndParseSubFile(dir: string): Segment[] | null {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json3'));
  if (files.length === 0) return null;

  const filePath = path.join(dir, files[0]);
  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    const json = JSON.parse(content);
    if (!json.events) return null;

    const results: Segment[] = [];
    for (const ev of json.events) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s: { utf8?: string }) => s.utf8 || '').join('').trim();
      if (!text || text === '\n') continue;
      const startSec = (ev.tStartMs || 0) / 1000;
      const durSec = (ev.dDurationMs || 0) / 1000;
      results.push({ start: startSec, end: startSec + durSec, text });
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}
