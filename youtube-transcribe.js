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
var NO_SUBTITLES_MARKER = "TRANSCRIBE_NO_SUBTITLES";
function assertAsrFlags(forceAsr, subsOnly) {
  if (forceAsr && subsOnly) throw new TranscribeError("--force-asr and --subs-only cannot be used together");
}
function stopIfSubsOnly(subsOnly) {
  if (subsOnly) throw new TranscribeError(`${NO_SUBTITLES_MARKER}: no subtitles found; --subs-only skips the Whisper fallback`);
}

// _download.js
import { execFile as execFile2, spawn } from "node:child_process";
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
async function checkFasterWhisper(python) {
  try {
    await execFileAsync(python, ["-c", "import faster_whisper"]);
  } catch (err) {
    throw new TranscribeError(
      `faster-whisper not importable with ${python}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. Install: pip install faster-whisper, or point TRANSCRIBE_FASTER_WHISPER_PYTHON at the venv python that has it`
    );
  }
}
async function checkFfmpeg() {
  await checkDep("ffmpeg", "Install: brew install ffmpeg  or  apt install ffmpeg");
}

// _download.js
var DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
async function runAbortableDownload(cmd, args, signal, env) {
  if (signal.aborted) throw new TranscribeError(`${cmd} download cancelled`);
  await new Promise((resolve, reject) => {
    let stderr = "";
    let stopped = false;
    const proc = spawn(cmd, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      env
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error("[transcribe] could not stop the audio download process group");
        }
      }
    };
    const timeout = setTimeout(stop, DOWNLOAD_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
    };
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    proc.once("error", (error) => {
      cleanup();
      reject(new TranscribeError(`${cmd} download failed: ${error.message}`));
    });
    proc.once("close", (code) => {
      cleanup();
      if (signal.aborted || stopped || code !== 0) {
        reject(new TranscribeError(`${cmd} download failed: ${signal.aborted ? "cancelled" : stderr.trim() || `exit ${code}`}`));
      } else {
        resolve();
      }
    });
  });
}
async function downloadAudioFromUrl(streamUrl, outputDir, signal) {
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  const args = ["-y", "-i", streamUrl, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath];
  if (signal) {
    await runAbortableDownload("ffmpeg", args, signal);
    return outputPath;
  }
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile2(
      "ffmpeg",
      args,
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
async function downloadAudio(url, outputDir, cookiesBrowser = "chrome", signal) {
  await checkYtDlp();
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  const args = [
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
  ];
  const env = {
    ...process.env,
    // yt-dlp needs GNOME keyring even when launched outside a full GUI session.
    DESKTOP_SESSION: process.env.DESKTOP_SESSION || "gnome"
  };
  if (signal) {
    await runAbortableDownload("yt-dlp", args, signal, env);
    return outputPath;
  }
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile2(
      "yt-dlp",
      args,
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        env
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
import { fileURLToPath } from "node:url";
var WHISPER_TIMEOUT_MS = 30 * 60 * 1e3;
var REMOTE_REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
var REMOTE_POLL_INTERVAL_MS = 1e4;
var REMOTE_HEARTBEAT_INTERVAL_MS = 3e4;
var DEFAULT_COMMAND_TIMEOUT_SECONDS = 25200;
var DEFAULT_WHISPER_MODEL = "large-v3";
var DEFAULT_COMPUTE_TYPE = "int8_float16";
var DEFAULT_FASTER_WHISPER_PYTHON = "python3";
var FASTER_WHISPER_SCRIPT = fileURLToPath(new URL("./_faster_whisper.py", import.meta.url));
function resolveWhisperModel(env = process.env) {
  const fromEnv = env.TRANSCRIBE_WHISPER_MODEL?.trim();
  return fromEnv ? fromEnv : DEFAULT_WHISPER_MODEL;
}
function whisperSource(model) {
  const slug = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `whisper_${slug || "unknown"}`;
}
function resolveWhisperSource(env = process.env) {
  return whisperSource(resolveWhisperModel(env));
}
function resolveWhisperBackend(env = process.env) {
  const fromEnv = env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase();
  if (!fromEnv || fromEnv === "openai") return "openai";
  if (fromEnv === "faster-whisper") return "faster-whisper";
  if (fromEnv === "remote") return "remote";
  throw new TranscribeError(
    `Unknown TRANSCRIBE_WHISPER_BACKEND "${env.TRANSCRIBE_WHISPER_BACKEND}". Use "openai", "faster-whisper", or "remote".`
  );
}
function buildWhisperCommand(audioPath, outputDir, lang, env = process.env) {
  const backend = resolveWhisperBackend(env);
  if (backend === "remote") throw new TranscribeError("Remote Whisper does not use a local command");
  const model = resolveWhisperModel(env);
  const args = [audioPath, "--model", model];
  if (backend === "openai") {
    args.push("--output_format", "json", "--output_dir", outputDir);
    if (lang) args.push("--language", lang);
    return { backend, cmd: "whisper", args, label: model };
  }
  const computeType = env.TRANSCRIBE_WHISPER_COMPUTE_TYPE?.trim() || DEFAULT_COMPUTE_TYPE;
  const python = env.TRANSCRIBE_FASTER_WHISPER_PYTHON?.trim() || DEFAULT_FASTER_WHISPER_PYTHON;
  args.push("--output_dir", outputDir, "--compute_type", computeType);
  if (lang) args.push("--language", lang);
  return {
    backend,
    cmd: python,
    args: [FASTER_WHISPER_SCRIPT, ...args],
    label: `${model} (faster-whisper, ${computeType})`
  };
}
var UNKNOWN_MODEL_SOURCE = whisperSource("");
async function transcribeWithWhisper(audioPath, outputDir, lang, timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS, signal) {
  if (resolveWhisperBackend() === "remote") return transcribeRemote(audioPath, lang, timeoutSeconds, signal);
  const command = buildWhisperCommand(audioPath, outputDir, lang);
  if (command.backend === "openai") await checkWhisper();
  else await checkFasterWhisper(command.cmd);
  const stem = path2.basename(audioPath, path2.extname(audioPath));
  const jsonOutput = path2.join(outputDir, `${stem}.json`);
  process.stderr.write(`[whisper] model: ${command.label}
`);
  try {
    await runWhisper(command.cmd, [...command.args, "--device", "cuda"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cuda|CUDA|RuntimeError/i.test(msg)) {
      console.error(`Warning: CUDA failed (${msg.split("\n")[0]}). Retrying on CPU...`);
      await runWhisper(command.cmd, [...command.args, "--device", "cpu"]);
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
  return {
    segments: segments.map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text).trim()
    })),
    // 本地后端：模型就是本地配置选的那个，标签与之一致
    source: resolveWhisperSource()
  };
}
function remoteBaseUrl(env = process.env) {
  const value = env.TRANSCRIBE_REMOTE_URL?.trim();
  if (!value) throw new TranscribeError("TRANSCRIBE_REMOTE_URL is required for the remote Whisper backend");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TranscribeError("TRANSCRIBE_REMOTE_URL must be an HTTP(S) service URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TranscribeError("TRANSCRIBE_REMOTE_URL must be an HTTP(S) service root without credentials or query");
  }
  return url.href.replace(/\/$/, "");
}
async function waitForPoll(signal) {
  await new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, REMOTE_POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function remoteRequest(url, init, signal) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)]),
    redirect: "error"
  });
}
async function transcribeRemote(audioPath, lang, timeoutSeconds, upstreamSignal) {
  const base = remoteBaseUrl();
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TranscribeError("Remote Whisper timeout must be a positive number of seconds");
  }
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Error("deadline exceeded")), timeoutSeconds * 1e3);
  const requestSignal = upstreamSignal ? AbortSignal.any([deadline.signal, upstreamSignal]) : deadline.signal;
  const startedAt = Date.now();
  let jobId = "";
  let status = "queued";
  let upload;
  const heartbeat = setInterval(() => {
    if (jobId) {
      const elapsed = Math.round((Date.now() - startedAt) / 1e3);
      process.stderr.write(`[whisper] remote job ${jobId} ${status} ${elapsed}s
`);
    }
  }, REMOTE_HEARTBEAT_INTERVAL_MS);
  try {
    const submitUrl = new URL(`${base}/api/whisper/jobs`);
    if (lang) submitUrl.searchParams.set("lang", lang);
    upload = fs.createReadStream(audioPath);
    const submitted = await remoteRequest(submitUrl.href, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: upload,
      duplex: "half"
    }, requestSignal);
    if (submitted.status !== 202) throw new TranscribeError(`Remote Whisper submit failed: HTTP ${submitted.status}`);
    const created = await submitted.json();
    if (typeof created.jobId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(created.jobId)) {
      throw new TranscribeError("Remote Whisper returned an invalid job ID");
    }
    jobId = created.jobId;
    for (; ; ) {
      const response = await remoteRequest(`${base}/api/whisper/jobs/${jobId}`, { method: "GET" }, requestSignal);
      if (response.status === 404) throw new TranscribeError(`Remote Whisper job ${jobId} not found (404)`);
      if (!response.ok) throw new TranscribeError(`Remote Whisper status failed: HTTP ${response.status}`);
      const result = await response.json();
      if (result.status === "completed") {
        if (!Array.isArray(result.segments)) throw new TranscribeError("Remote Whisper result has no segments");
        const source = typeof result.model === "string" && result.model.trim() ? whisperSource(result.model) : UNKNOWN_MODEL_SOURCE;
        const segments = result.segments.map((segment) => {
          if (!segment || typeof segment.start !== "number" || !Number.isFinite(segment.start) || segment.start < 0 || typeof segment.end !== "number" || !Number.isFinite(segment.end) || segment.end < segment.start || typeof segment.text !== "string" || !segment.text.trim()) {
            throw new TranscribeError("Remote Whisper returned an invalid segment");
          }
          return { start: segment.start, end: segment.end, text: segment.text.trim() };
        });
        return { segments, source };
      }
      if (result.status === "failed") {
        const summary = typeof result.error === "string" ? result.error.slice(0, 200) : "unknown error";
        throw new TranscribeError(`Remote Whisper job failed: ${summary}`);
      }
      if (result.status !== "queued" && result.status !== "running") {
        throw new TranscribeError("Remote Whisper returned an invalid job status");
      }
      status = result.status;
      await waitForPoll(requestSignal);
    }
  } catch (error) {
    if (error instanceof TranscribeError) throw error;
    if (requestSignal.aborted) throw new TranscribeError("Remote Whisper command timed out");
    throw new TranscribeError(`Remote Whisper request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeat);
    upload?.destroy();
  }
}
async function runWhisper(cmd, args) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1e3);
      process.stderr.write(`[whisper] transcribing... ${elapsed}s elapsed
`);
    }, 3e4);
    const proc = execFile3(cmd, args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
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
  description: "Transcribe a YouTube video (subtitles first, Whisper fallback)",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  access: "read",
  timeoutSeconds: 25200,
  // 7 hours — Whisper on long videos can take a while
  args: [
    { name: "url", required: true, positional: true, help: "YouTube video URL or video ID" },
    { name: "timeout", required: false, type: "int", default: 25200, help: "Command timeout in seconds (default: 7 hours)" },
    { name: "lang", required: false, help: "Language code (e.g. en, zh-Hans). Omit to auto-select" },
    { name: "mode", required: false, default: "raw", choices: ["raw", "grouped"], help: "Output mode: raw (per-segment with timestamps) or grouped (merged paragraphs)" },
    { name: "force-asr", required: false, type: "boolean", default: false, help: "Skip subtitles and always use Whisper" },
    { name: "subs-only", required: false, type: "boolean", default: false, help: "Only fetch subtitles; fail with TRANSCRIBE_NO_SUBTITLES instead of falling back to Whisper" },
    { name: "keep-audio", required: false, type: "boolean", default: false, help: "Keep temporary audio file after transcription" }
  ],
  func: async (page, kwargs) => {
    const commandStartedAt = Date.now();
    const url = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : "";
    const mode = String(kwargs.mode || "raw");
    const forceAsr = Boolean(kwargs["force-asr"]);
    const keepAudio = Boolean(kwargs["keep-audio"]);
    const timeoutSeconds = Number(kwargs.timeout ?? 25200);
    const subsOnly = Boolean(kwargs["subs-only"]);
    assertAsrFlags(forceAsr, subsOnly);
    const videoId = parseVideoId(url);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const whisperLang = lang ? langMap(lang) : void 0;
    let ytAudioUrl = null;
    if (!forceAsr) {
      if (page && !subsOnly) {
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
    stopIfSubsOnly(subsOnly);
    console.error(`[transcribe] No subtitles found. Falling back to Whisper ASR (${resolveWhisperModel()})...`);
    const remoteMode = process.env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase() === "remote";
    const remainingMs = timeoutSeconds * 1e3 - (Date.now() - commandStartedAt);
    if (remoteMode && remainingMs <= 0) throw new TranscribeError("Remote Whisper command timed out");
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);
    const remoteDeadline = remoteMode ? new AbortController() : void 0;
    const remoteTimer = remoteDeadline ? setTimeout(() => remoteDeadline.abort(new Error("deadline exceeded")), remainingMs) : void 0;
    try {
      if (ytAudioUrl) {
        console.error("[transcribe] Downloading audio via streaming URL...");
      } else {
        console.error("[transcribe] Downloading audio via yt-dlp...");
      }
      const audioPath = ytAudioUrl ? await downloadAudioFromUrl(ytAudioUrl, tempDir, remoteDeadline?.signal) : await downloadAudio(url, tempDir, "chrome", remoteDeadline?.signal);
      console.error("[transcribe] Audio ready. Starting Whisper transcription (this may take several minutes)...");
      const { segments, source } = await transcribeWithWhisper(audioPath, tempDir, whisperLang, timeoutSeconds, remoteDeadline?.signal);
      if (segments.length === 0) {
        throw new TranscribeError("Whisper returned no segments. The audio may be too short or silent.");
      }
      return mode === "raw" ? formatRaw(segments, source) : formatGrouped(segments, source);
    } catch (error) {
      if (remoteDeadline?.signal.aborted) throw new TranscribeError("Remote Whisper command timed out");
      throw error;
    } finally {
      if (remoteTimer) clearTimeout(remoteTimer);
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
