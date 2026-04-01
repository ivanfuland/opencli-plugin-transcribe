/**
 * opencli-plugin-transcribe: youtube transcribe command
 *
 * Subtitle-first (InnerTube Android API), Whisper large-v3 fallback.
 * Reference: src/clis/youtube/transcript.ts (2026-04-01)
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { TranscribeError } from './_errors.js';
import { downloadAudio } from './_download.js';
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
  args: [
    { name: 'url', required: true, positional: true, help: 'YouTube video URL or video ID' },
    { name: 'lang', required: false, help: 'Language code (e.g. en, zh-Hans). Omit to auto-select' },
    { name: 'mode', required: false, default: 'grouped', choices: ['grouped', 'raw'], help: 'Output mode: grouped or raw' },
    { name: 'force-asr', required: false, type: 'boolean', default: false, help: 'Skip subtitles and always use Whisper' },
    { name: 'keep-audio', required: false, type: 'boolean', default: false, help: 'Keep temporary audio file after transcription' },
  ],
  func: async (page, kwargs) => {
    const url = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : '';
    const mode = String(kwargs.mode || 'grouped');
    const forceAsr = Boolean(kwargs['force-asr']);
    const keepAudio = Boolean(kwargs['keep-audio']);

    const videoId = parseVideoId(url);
    const whisperLang = lang ? langMap(lang) : undefined;

    // ── Step 1: Try platform subtitles (unless --force-asr) ──────────────────
    if (!forceAsr && page) {
      // Navigate to youtube.com to ensure we have INNERTUBE_API_KEY in ytcfg
      await page.goto('https://www.youtube.com', { waitUntil: 'none' });
      await page.wait(2);

      const captionData = await page.evaluate(`
        (async () => {
          const cfg = window.ytcfg?.data_ || {};
          const apiKey = cfg.INNERTUBE_API_KEY;
          if (!apiKey) return { error: 'INNERTUBE_API_KEY not found on page' };

          const resp = await fetch('/youtubei/v1/player?key=' + apiKey + '&prettyPrint=false', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
              videoId: ${JSON.stringify(videoId)}
            })
          });

          if (!resp.ok) return { error: 'InnerTube player API returned HTTP ' + resp.status };
          const data = await resp.json();

          const renderer = data.captions?.playerCaptionsTracklistRenderer;
          if (!renderer?.captionTracks?.length) {
            return { noCaption: true };
          }

          const tracks = renderer.captionTracks;
          const available = tracks.map(t => t.languageCode + (t.kind === 'asr' ? ' (auto)' : ''));

          const langPref = ${JSON.stringify(lang)};
          let track = null;
          if (langPref) {
            track = tracks.find(t => t.languageCode === langPref)
              || tracks.find(t => t.languageCode.startsWith(langPref));
          }
          if (!track) {
            track = tracks.find(t => t.kind !== 'asr') || tracks[0];
          }

          return {
            captionUrl: track.baseUrl,
            language: track.languageCode,
            kind: track.kind || 'manual',
            available,
            requestedLang: langPref || null,
            langMatched: !!(langPref && track.languageCode === langPref),
            langPrefixMatched: !!(langPref && track.languageCode !== langPref && track.languageCode.startsWith(langPref))
          };
        })()
      `);

      if (captionData && !captionData.error && !captionData.noCaption) {
        // Warn if requested language not matched
        if (captionData.requestedLang && !captionData.langMatched && !captionData.langPrefixMatched) {
          console.error(`Warning: --lang "${captionData.requestedLang}" not found. Using "${captionData.language}" instead. Available: ${captionData.available.join(', ')}`);
        }

        // Fetch and parse caption XML
        const segments: Segment[] | { error: string } = await page.evaluate(`
          (async () => {
            const resp = await fetch(${JSON.stringify(captionData.captionUrl)});
            const xml = await resp.text();

            if (!xml?.length) return { error: 'Caption URL returned empty response' };

            function getAttr(tag, name) {
              const needle = name + '=\\"';
              const idx = tag.indexOf(needle);
              if (idx === -1) return '';
              const valStart = idx + needle.length;
              const valEnd = tag.indexOf('\\"', valStart);
              if (valEnd === -1) return '';
              return tag.substring(valStart, valEnd);
            }

            function decodeEntities(s) {
              return s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
            }

            const isFormat3 = xml.includes('<p t=\\"');
            const marker = isFormat3 ? '<p ' : '<text ';
            const endMarker = isFormat3 ? '</p>' : '</text>';
            const results = [];
            let pos = 0;

            while (true) {
              const tagStart = xml.indexOf(marker, pos);
              if (tagStart === -1) break;
              let contentStart = xml.indexOf('>', tagStart);
              if (contentStart === -1) break;
              contentStart += 1;
              const tagEnd = xml.indexOf(endMarker, contentStart);
              if (tagEnd === -1) break;

              const attrStr = xml.substring(tagStart + marker.length, contentStart - 1);
              const content = xml.substring(contentStart, tagEnd);

              let startSec, durSec;
              if (isFormat3) {
                startSec = (parseFloat(getAttr(attrStr, 't')) || 0) / 1000;
                durSec = (parseFloat(getAttr(attrStr, 'd')) || 0) / 1000;
              } else {
                startSec = parseFloat(getAttr(attrStr, 'start')) || 0;
                durSec = parseFloat(getAttr(attrStr, 'dur')) || 0;
              }

              const text = decodeEntities(content.replace(/<[^>]+>/g, '')).split('\\\\n').join(' ').trim();
              if (text) results.push({ start: startSec, end: startSec + durSec, text });
              pos = tagEnd + endMarker.length;
            }

            if (results.length === 0) return { error: 'Parsed 0 segments from caption XML' };
            return results;
          })()
        `);

        if (Array.isArray(segments) && segments.length > 0) {
          const source = captionData.kind === 'asr' ? 'auto_caption' : 'manual_caption';
          return mode === 'raw'
            ? formatRaw(segments as Segment[], source)
            : formatGrouped(segments as Segment[], source);
        }
      }
      // Fall through to Whisper
    }

    // ── Step 2: Whisper fallback ─────────────────────────────────────────────
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);

    try {
      const audioPath = await downloadAudio(url, tempDir);
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

function parseVideoId(input: string): string {
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
