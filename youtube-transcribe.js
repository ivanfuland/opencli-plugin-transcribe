// youtube-transcribe.ts
import { execFile as execFile4 } from "node:child_process";
import * as fs3 from "node:fs";
import * as path4 from "node:path";
import { cli, Strategy } from "@jackwener/opencli/registry";

// _errors.js
var TranscribeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscribeError";
  }
};

// _download.js
import { execFile as execFile2 } from "node:child_process";
import * as path from "node:path";

// _deps.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function checkDep(name, installHint) {
  try {
    await execFileAsync("which", [name]);
  } catch {
    throw new TranscribeError(`${name} not found. ${installHint}`);
  }
}
async function checkYtDlp() {
  await checkDep("yt-dlp", "Install: pip install yt-dlp  or  brew install yt-dlp");
}
async function checkWhisper() {
  await checkDep("whisper", "Install: pip install openai-whisper");
}
async function checkFfmpeg() {
  await checkDep("ffmpeg", "Install: brew install ffmpeg  or  apt install ffmpeg");
}

// _download.js
var DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
async function downloadAudioFromUrl(streamUrl, outputDir) {
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile2(
      "ffmpeg",
      ["-y", "-i", streamUrl, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath],
      { timeout: DOWNLOAD_TIMEOUT_MS },
      (err) => {
        if (err) {
          reject(new TranscribeError(
            `ffmpeg download failed: ${stderr.trim() || err.message}`
          ));
        } else {
          resolve();
        }
      }
    );
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });
  return outputPath;
}
async function downloadAudio(url, outputDir, cookiesBrowser = "chrome") {
  await checkYtDlp();
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile2(
      "yt-dlp",
      [
        "-x",
        "--audio-format",
        "wav",
        "-o",
        outputPath,
        "--cookies-from-browser",
        cookiesBrowser,
        "--remote-components",
        "ejs:github",
        "--no-playlist",
        url
      ],
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        env: {
          ...process.env,
          // Ensure yt-dlp picks GNOME keyring even when DESKTOP_SESSION is unset
          // (e.g. when launched outside a full GUI session)
          DESKTOP_SESSION: process.env.DESKTOP_SESSION || "gnome"
        }
      },
      (err) => {
        if (err) {
          reject(new TranscribeError(
            `yt-dlp download failed: ${stderr.trim() || err.message}`
          ));
        } else {
          resolve();
        }
      }
    );
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });
  return outputPath;
}

// _whisper.js
import { execFile as execFile3 } from "node:child_process";
import * as fs from "node:fs";
import * as path2 from "node:path";
var WHISPER_TIMEOUT_MS = 30 * 60 * 1e3;
async function transcribeWithWhisper(audioPath, outputDir, lang) {
  await checkWhisper();
  const stem = path2.basename(audioPath, path2.extname(audioPath));
  const jsonOutput = path2.join(outputDir, `${stem}.json`);
  const baseArgs = [
    audioPath,
    "--model",
    "large-v3",
    "--output_format",
    "json",
    "--output_dir",
    outputDir
  ];
  if (lang) baseArgs.push("--language", lang);
  try {
    await runWhisper([...baseArgs, "--device", "cuda"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cuda|CUDA|RuntimeError/i.test(msg)) {
      console.error(`Warning: CUDA failed (${msg.split("\n")[0]}). Retrying on CPU...`);
      await runWhisper([...baseArgs, "--device", "cpu"]);
    } else {
      throw err;
    }
  }
  let parsed;
  try {
    const raw = fs.readFileSync(jsonOutput, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TranscribeError(
      `Failed to read Whisper output at ${jsonOutput}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const segments = parsed.segments ?? [];
  return segments.map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim()
  }));
}
async function runWhisper(args) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1e3);
      process.stderr.write(`[whisper] transcribing... ${elapsed}s elapsed
`);
    }, 3e4);
    const proc = execFile3("whisper", args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
      clearInterval(heartbeat);
      if (err) {
        reject(new TranscribeError(
          `Whisper transcription failed: ${stderr.trim() || err.message}`
        ));
      } else {
        resolve();
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });
}

// _format.js
var SENTENCE_END = /[.!?\u3002\uFF01\uFF1F\uFF0E]["'\u2019\u201D)]*\s*$/;
var MAX_GROUP_SPAN_SECONDS = 30;
var TRANSCRIPT_GROUP_GAP_SECONDS = 20;
function formatRaw(segments, source) {
  return segments.map((seg, i) => ({
    index: i + 1,
    start: Number(seg.start).toFixed(2) + "s",
    end: Number(seg.end).toFixed(2) + "s",
    text: seg.text,
    source
  }));
}
function formatGrouped(segments, source) {
  if (segments.length === 0) return [];
  const groups = groupBySentence(segments);
  return groups.map((g) => ({
    timestamp: fmtTime(g.start),
    text: g.text,
    source
  }));
}
function groupBySentence(segments) {
  const groups = [];
  let buffer = "";
  let bufferStart = 0;
  let lastStart = 0;
  const flush = () => {
    if (buffer.trim()) {
      groups.push({ start: bufferStart, text: buffer.trim() });
      buffer = "";
    }
  };
  for (const seg of segments) {
    if (buffer && seg.start - lastStart > TRANSCRIPT_GROUP_GAP_SECONDS) {
      flush();
    }
    if (buffer && seg.start - bufferStart > MAX_GROUP_SPAN_SECONDS) {
      flush();
    }
    if (!buffer) bufferStart = seg.start;
    buffer += (buffer ? " " : "") + seg.text;
    lastStart = seg.start;
    if (SENTENCE_END.test(seg.text)) flush();
  }
  flush();
  return groups;
}
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// _temp.js
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path3 from "node:path";
function createTempDir() {
  return fs2.mkdtempSync(path3.join(os.tmpdir(), "opencli-transcribe-"));
}
function cleanupTempDir(dir, keepAudio) {
  if (keepAudio) {
    console.error(`Audio kept at: ${dir}`);
    return;
  }
  try {
    fs2.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function registerCleanupHook(dir) {
  const handler = () => {
    try {
      fs2.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

// _lang-map.js
var LANG_MAP = {
  "zh-Hans": "zh",
  "zh-Hant": "zh",
  "zh-CN": "zh",
  "zh-TW": "zh",
  "zh-HK": "zh",
  "en-US": "en",
  "en-GB": "en",
  "en-AU": "en",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "fr-FR": "fr",
  "de-DE": "de",
  "es-ES": "es",
  "es-MX": "es",
  "pt-BR": "pt",
  "pt-PT": "pt",
  "ru-RU": "ru",
  "ar-SA": "ar",
  "hi-IN": "hi",
  "it-IT": "it",
  "nl-NL": "nl",
  "pl-PL": "pl",
  "tr-TR": "tr",
  "vi-VN": "vi",
  "th-TH": "th",
  "id-ID": "id",
  "ms-MY": "ms"
};
function langMap(code) {
  return LANG_MAP[code] ?? code;
}

// _pick-subtitle-lang.js
var LANG_PREFERENCE = ["zh-Hans", "zh-Hant", "zh", "en", "ja", "ko"];
function pickSubtitleLang(manualLangs, autoLangs, userLang, videoLang) {
  if (userLang) {
    const exactManual = manualLangs.find((l) => l === userLang);
    if (exactManual) return { lang: exactManual, isAuto: false };
    const prefixManual = manualLangs.find((l) => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixManual) return { lang: prefixManual, isAuto: false };
    const exactAuto = autoLangs.find((l) => l === userLang);
    if (exactAuto) return { lang: exactAuto, isAuto: true };
    const prefixAuto = autoLangs.find((l) => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixAuto) return { lang: prefixAuto, isAuto: true };
  }
  const pref = videoLang ? [videoLang, ...LANG_PREFERENCE.filter((l) => l !== videoLang)] : LANG_PREFERENCE;
  for (const p of pref) {
    const manual = manualLangs.find((l) => l === p);
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const manual = manualLangs.find((l) => l.startsWith(p) || p.startsWith(l));
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const auto = autoLangs.find((l) => l === p);
    if (auto) return { lang: auto, isAuto: true };
  }
  for (const p of pref) {
    const auto = autoLangs.find((l) => l.startsWith(p) || p.startsWith(l));
    if (auto) return { lang: auto, isAuto: true };
  }
  if (manualLangs.length > 0) return { lang: manualLangs[0], isAuto: false };
  if (autoLangs.length > 0) return { lang: autoLangs[0], isAuto: true };
  return null;
}

// youtube-transcribe.ts
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
    { name: "mode", required: false, default: "raw", choices: ["raw", "grouped"], help: "Output mode: raw (per-segment with timestamps) or grouped (merged paragraphs)" },
    { name: "force-asr", required: false, type: "boolean", default: false, help: "Skip subtitles and always use Whisper" },
    { name: "keep-audio", required: false, type: "boolean", default: false, help: "Keep temporary audio file after transcription" }
  ],
  func: async (page, kwargs) => {
    const url = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : "";
    const mode = String(kwargs.mode || "raw");
    const forceAsr = Boolean(kwargs["force-asr"]);
    const keepAudio = Boolean(kwargs["keep-audio"]);
    const videoId = parseVideoId(url);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const whisperLang = lang ? langMap(lang) : void 0;
    let ytAudioUrl = null;
    if (!forceAsr) {
      if (page) {
        try {
          await page.goto(videoUrl, { waitUntil: "domcontentloaded" });
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
        }
      }
      console.error("[transcribe] Checking for subtitles via yt-dlp...");
      const tempDir2 = createTempDir();
      try {
        const result = await downloadSubtitlesViaYtDlp(videoUrl, tempDir2, lang);
        if (result && result.segments.length > 0) {
          const source = result.isAuto ? "auto_caption" : "manual_caption";
          cleanupTempDir(tempDir2, false);
          return mode === "raw" ? formatRaw(result.segments, source) : formatGrouped(result.segments, source);
        }
        cleanupTempDir(tempDir2, false);
      } catch (err) {
        cleanupTempDir(tempDir2, false);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[transcribe] Subtitle download failed: ${msg}`);
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
async function downloadSubtitlesViaYtDlp(videoUrl, outputDir, lang) {
  console.error("[transcribe] Fetching available subtitle languages...");
  const info = await getSubtitleInfo(videoUrl);
  const manualLangs = Object.keys(info.subtitles);
  const autoLangs = Object.keys(info.automatic_captions);
  const videoLang = info.language ? langMap(info.language) : void 0;
  console.error(`[transcribe] Manual: [${manualLangs.join(", ")}], Auto: ${autoLangs.length} languages, Original: ${videoLang ?? "unknown"}`);
  if (manualLangs.length === 0 && autoLangs.length === 0) return null;
  const picked = pickSubtitleLang(manualLangs, autoLangs, lang, videoLang);
  if (!picked) return null;
  console.error(`[transcribe] Selected: ${picked.lang} (${picked.isAuto ? "auto" : "manual"})`);
  const outputTemplate = path4.join(outputDir, "sub");
  await runYtDlpSubDownload(videoUrl, outputTemplate, picked.lang, picked.isAuto);
  const segments = findAndParseSubFile(outputDir);
  if (!segments) return null;
  return { segments, isAuto: picked.isAuto };
}
function getSubtitleInfo(videoUrl) {
  return new Promise((resolve, reject) => {
    execFile4(
      "yt-dlp",
      [
        "--dump-json",
        "--skip-download",
        "--no-playlist",
        "--cookies-from-browser",
        "chrome",
        "--remote-components",
        "ejs:github",
        videoUrl
      ],
      {
        timeout: 6e4,
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          DESKTOP_SESSION: process.env.DESKTOP_SESSION || "gnome"
        }
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new TranscribeError(`yt-dlp metadata fetch failed: ${stderr?.trim() || err.message}`));
          return;
        }
        try {
          const json = JSON.parse(stdout);
          resolve({
            subtitles: json.subtitles || {},
            automatic_captions: json.automatic_captions || {},
            language: typeof json.language === "string" ? json.language : null
          });
        } catch {
          reject(new TranscribeError("Failed to parse yt-dlp JSON output"));
        }
      }
    );
  });
}
function runYtDlpSubDownload(videoUrl, outputTemplate, subLang, autoSub) {
  const args = [
    "--skip-download",
    "--no-playlist",
    "--sub-format",
    "json3",
    "-o",
    outputTemplate,
    "--cookies-from-browser",
    "chrome",
    "--remote-components",
    "ejs:github"
  ];
  if (autoSub) {
    args.push("--write-auto-sub", "--sub-lang", subLang);
  } else {
    args.push("--write-sub", "--sub-lang", subLang);
  }
  args.push(videoUrl);
  return new Promise((resolve, reject) => {
    let stderr = "";
    execFile4(
      "yt-dlp",
      args,
      {
        timeout: 6e4,
        env: {
          ...process.env,
          DESKTOP_SESSION: process.env.DESKTOP_SESSION || "gnome"
        }
      },
      (err) => {
        if (err) {
          reject(new TranscribeError(`yt-dlp subtitle download failed: ${stderr.trim() || err.message}`));
        } else {
          resolve();
        }
      }
    ).stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  });
}
function findAndParseSubFile(dir) {
  const files = fs3.readdirSync(dir).filter((f) => f.endsWith(".json3"));
  if (files.length === 0) return null;
  const filePath = path4.join(dir, files[0]);
  const content = fs3.readFileSync(filePath, "utf-8");
  try {
    const json = JSON.parse(content);
    if (!json.events) return null;
    const results = [];
    for (const ev of json.events) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").trim();
      if (!text || text === "\n") continue;
      const startSec = (ev.tStartMs || 0) / 1e3;
      const durSec = (ev.dDurationMs || 0) / 1e3;
      results.push({ start: startSec, end: startSec + durSec, text });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}
export {
  parseVideoId
};
