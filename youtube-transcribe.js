import { cli, Strategy } from "@jackwener/opencli/registry";
import { TranscribeError } from "./_errors.js";
import { downloadAudio, downloadAudioFromUrl } from "./_download.js";
import { transcribeWithWhisper } from "./_whisper.js";
import { formatRaw, formatGrouped } from "./_format.js";
import { createTempDir, cleanupTempDir, registerCleanupHook } from "./_temp.js";
import { langMap } from "./_lang-map.js";
cli({
  site: "youtube",
  name: "transcribe",
  description: "Transcribe a YouTube video (subtitles first, Whisper large-v3 fallback)",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  timeoutSeconds: 25200,
  // 7 hours — Whisper large-v3 on long videos can take a while
  args: [
    { name: "url", required: true, positional: true, help: "YouTube video URL or video ID" },
    { name: "lang", required: false, help: "Language code (e.g. en, zh-Hans). Omit to auto-select" },
    { name: "mode", required: false, default: "grouped", choices: ["grouped", "raw"], help: "Output mode: grouped or raw" },
    { name: "force-asr", required: false, type: "boolean", default: false, help: "Skip subtitles and always use Whisper" },
    { name: "keep-audio", required: false, type: "boolean", default: false, help: "Keep temporary audio file after transcription" }
  ],
  func: async (page, kwargs) => {
    const url = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : "";
    const mode = String(kwargs.mode || "grouped");
    const forceAsr = Boolean(kwargs["force-asr"]);
    const keepAudio = Boolean(kwargs["keep-audio"]);
    const videoId = parseVideoId(url);
    const whisperLang = lang ? langMap(lang) : void 0;
    let ytAudioUrl = null;
    if (!forceAsr && page) {
      const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}`;
      await page.goto(videoPageUrl, { waitUntil: "domcontentloaded" });
      const captionData = await page.evaluate(`
        (() => {
          const data = window.ytInitialPlayerResponse;
          if (!data) return { error: 'ytInitialPlayerResponse not found' };

          // Extract best audio-only streaming URL (itag 140 = m4a 128kbps)
          const formats = data.streamingData?.adaptiveFormats ?? [];
          const audioFmt = formats.find(f => f.itag === 140 && f.url)
            || formats.find(f => f.mimeType?.startsWith('audio/') && f.url);
          const audioUrl = audioFmt?.url ?? null;

          const renderer = data.captions?.playerCaptionsTracklistRenderer;
          if (!renderer?.captionTracks?.length) {
            return { noCaption: true, audioUrl };
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
            audioUrl,
            language: track.languageCode,
            kind: track.kind || 'manual',
            available,
            requestedLang: langPref || null,
            langMatched: !!(langPref && track.languageCode === langPref),
            langPrefixMatched: !!(langPref && track.languageCode !== langPref && track.languageCode.startsWith(langPref))
          };
        })()
      `);
      if (captionData?.audioUrl) ytAudioUrl = captionData.audioUrl;
      if (captionData && !captionData.error && !captionData.noCaption) {
        if (captionData.requestedLang && !captionData.langMatched && !captionData.langPrefixMatched) {
          console.error(`Warning: --lang "${captionData.requestedLang}" not found. Using "${captionData.language}" instead. Available: ${captionData.available.join(", ")}`);
        }
        const segments = await page.evaluate(`
          (async () => {
            const resp = await fetch(${JSON.stringify(captionData.captionUrl)});
            const xml = await resp.text();

            if (!xml?.length) return { error: 'Caption URL returned empty response' };

            function getAttr(tag, name) {
              const needle = name + '="';
              const idx = tag.indexOf(needle);
              if (idx === -1) return '';
              const valStart = idx + needle.length;
              const valEnd = tag.indexOf('"', valStart);
              if (valEnd === -1) return '';
              return tag.substring(valStart, valEnd);
            }

            function decodeEntities(s) {
              return s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
            }

            const isFormat3 = xml.includes('<p t="');
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

              const text = decodeEntities(content.replace(/<[^>]+>/g, '')).split('\\n').join(' ').trim();
              if (text) results.push({ start: startSec, end: startSec + durSec, text });
              pos = tagEnd + endMarker.length;
            }

            if (results.length === 0) return { error: 'Parsed 0 segments from caption XML' };
            return results;
          })()
        `);
        if (Array.isArray(segments) && segments.length > 0) {
          const source = captionData.kind === "asr" ? "auto_caption" : "manual_caption";
          return mode === "raw" ? formatRaw(segments, source) : formatGrouped(segments, source);
        }
      }
    }
    console.error("[transcribe] No subtitles found. Falling back to Whisper large-v3 ASR...");
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);
    try {
      if (ytAudioUrl) {
        console.error("[transcribe] Downloading audio via streaming URL...");
      } else {
        console.error("[transcribe] Downloading audio via yt-dlp...");
      }
      const audioPath = ytAudioUrl ? await downloadAudioFromUrl(ytAudioUrl, tempDir) : await downloadAudio(url, tempDir);
      console.error("[transcribe] Audio ready. Starting Whisper transcription (this may take several minutes)...");
      const segments = await transcribeWithWhisper(audioPath, tempDir, whisperLang);
      if (segments.length === 0) {
        throw new TranscribeError("Whisper returned no segments. The audio may be too short or silent.");
      }
      return mode === "raw" ? formatRaw(segments, "whisper_large_v3") : formatGrouped(segments, "whisper_large_v3");
    } finally {
      deregister();
      cleanupTempDir(tempDir, keepAudio);
    }
  }
});
function parseVideoId(input) {
  if (!input.startsWith("http")) return input;
  try {
    const parsed = new URL(input);
    if (parsed.searchParams.has("v")) return parsed.searchParams.get("v");
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("/")[0];
    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
    if (pathMatch) return pathMatch[2];
  } catch {
  }
  return input;
}
export {
  parseVideoId
};
