// bilibili-transcribe.ts
import { createHash } from "node:crypto";
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
function whisperRunLabel(env = process.env) {
  return resolveWhisperBackend(env) === "remote" ? "remote" : resolveWhisperModel(env);
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

// bilibili-transcribe.ts
var MIXIN_KEY_ENC_TAB = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];
cli({
  site: "bilibili",
  name: "transcribe",
  description: "\u8F6C\u5F55 Bilibili \u89C6\u9891\uFF08\u5B57\u5E55\u4F18\u5148\uFF0C\u65E0\u5B57\u5E55\u65F6 Whisper \u515C\u5E95\uFF09",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  access: "read",
  timeoutSeconds: 25200,
  // 7 hours — Whisper on long videos can take a while
  args: [
    { name: "url", required: true, positional: true, help: "Bilibili \u89C6\u9891 URL \u6216 BVID (\u5982 BV1xxxxxx)" },
    { name: "timeout", required: false, type: "int", default: 25200, help: "\u547D\u4EE4\u8D85\u65F6\u79D2\u6570\uFF08\u9ED8\u8BA4 7 \u5C0F\u65F6\uFF09" },
    { name: "lang", required: false, help: "\u5B57\u5E55\u8BED\u8A00\u4EE3\u7801 (\u5982 zh-CN, en-US)" },
    { name: "mode", required: false, default: "raw", choices: ["raw", "grouped"], help: "\u8F93\u51FA\u6A21\u5F0F\uFF1Araw\uFF08\u9010\u53E5\u5E26\u65F6\u95F4\u6233\uFF09\u6216 grouped\uFF08\u5408\u5E76\u6BB5\u843D\uFF09" },
    { name: "force-asr", required: false, type: "boolean", default: false, help: "\u8DF3\u8FC7\u5B57\u5E55\uFF0C\u76F4\u63A5\u4F7F\u7528 Whisper" },
    { name: "subs-only", required: false, type: "boolean", default: false, help: "\u53EA\u53D6\u5B57\u5E55\uFF1B\u6CA1\u6709\u5B57\u5E55\u65F6\u4EE5 TRANSCRIBE_NO_SUBTITLES \u5931\u8D25\uFF0C\u4E0D\u56DE\u843D\u5230 Whisper" },
    { name: "keep-audio", required: false, type: "boolean", default: false, help: "\u4FDD\u7559\u4E34\u65F6\u97F3\u9891\u6587\u4EF6" }
  ],
  func: async (page, kwargs) => {
    const commandStartedAt = Date.now();
    const inputUrl = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : "";
    const mode = String(kwargs.mode || "raw");
    const forceAsr = Boolean(kwargs["force-asr"]);
    const keepAudio = Boolean(kwargs["keep-audio"]);
    const timeoutSeconds = Number(kwargs.timeout ?? 25200);
    const subsOnly = Boolean(kwargs["subs-only"]);
    assertAsrFlags(forceAsr, subsOnly);
    const videoUrl = normalizeBilibiliUrl(inputUrl);
    const whisperLang = lang ? langMap(lang) : void 0;
    if (!forceAsr && page) {
      try {
        const result = await fetchBilibiliSubtitle(page, videoUrl, inputUrl, lang);
        if (result !== null) {
          const { segments, source } = result;
          return mode === "raw" ? formatRaw(segments, source) : formatGrouped(segments, source);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: subtitle fetch failed (${msg}), falling back to Whisper`);
      }
    }
    stopIfSubsOnly(subsOnly);
    console.error(`[transcribe] \u672A\u627E\u5230\u5B57\u5E55\uFF0C\u56DE\u843D\u5230 Whisper ASR\uFF08${whisperRunLabel()}\uFF09...`);
    const remoteMode = process.env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase() === "remote";
    const remainingMs = timeoutSeconds * 1e3 - (Date.now() - commandStartedAt);
    if (remoteMode && remainingMs <= 0) throw new TranscribeError("Remote Whisper command timed out");
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);
    const remoteDeadline = remoteMode ? new AbortController() : void 0;
    const remoteTimer = remoteDeadline ? setTimeout(() => remoteDeadline.abort(new Error("deadline exceeded")), remainingMs) : void 0;
    try {
      console.error("[transcribe] \u6B63\u5728\u901A\u8FC7 yt-dlp \u4E0B\u8F7D\u97F3\u9891...");
      const audioPath = await downloadAudio(videoUrl, tempDir, "chrome", remoteDeadline?.signal);
      console.error("[transcribe] \u97F3\u9891\u5C31\u7EEA\uFF0C\u5F00\u59CB Whisper \u8F6C\u5F55\uFF08\u53EF\u80FD\u9700\u8981\u6570\u5206\u949F\uFF09...");
      const { segments, source } = await transcribeWithWhisper(audioPath, tempDir, whisperLang, timeoutSeconds, remoteDeadline?.signal);
      if (segments.length === 0) {
        throw new TranscribeError("Whisper \u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55\u7247\u6BB5\uFF0C\u97F3\u9891\u53EF\u80FD\u8FC7\u77ED\u6216\u65E0\u58F0\u3002");
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
function normalizeBilibiliUrl(input) {
  if (input.startsWith("http")) return input;
  if (/^BV[a-zA-Z0-9]+$/.test(input)) {
    return `https://www.bilibili.com/video/${input}`;
  }
  return `https://www.bilibili.com/video/${input}`;
}
async function fetchBilibiliSubtitle(page, videoUrl, originalInput, lang) {
  await page.goto(videoUrl);
  const cid = await page.evaluate(`(async () => {
    const state = window.__INITIAL_STATE__ || {};
    return state?.videoData?.cid;
  })()`);
  if (!cid) {
    throw new TranscribeError("\u65E0\u6CD5\u4ECE\u9875\u9762\u63D0\u53D6 CID\uFF0C\u8BF7\u68C0\u67E5\u89C6\u9891\u9875\u9762\u662F\u5426\u6B63\u5E38\u52A0\u8F7D\u3002\u5982\u9875\u9762\u7ED3\u6784\u5DF2\u53D8\u5316\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6\u3002");
  }
  const bvid = extractBvid(originalInput) || extractBvid(videoUrl) || originalInput;
  const navData = await page.evaluate(`(async () => {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    return await res.json();
  })()`);
  const wbiImg = navData?.data?.wbi_img ?? {};
  const imgKey = (wbiImg.img_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const subKey = (wbiImg.sub_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const signedParams = await wbiSign({ bvid, cid: String(cid) }, imgKey, subKey);
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(signedParams).map(([k, v]) => [k, String(v)]))
  ).toString().replace(/\+/g, "%20");
  const apiUrl = `https://api.bilibili.com/x/player/wbi/v2?${qs}`;
  const payload = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include' });
    return await res.json();
  })()`);
  if (payload?.code !== 0) {
    throw new TranscribeError(`\u83B7\u53D6\u5B57\u5E55\u5217\u8868\u5931\u8D25: ${payload?.message ?? "unknown"} (${payload?.code ?? "?"})`);
  }
  const needLogin = payload?.data?.need_login_subtitle === true;
  const subtitles = payload?.data?.subtitle?.subtitles ?? [];
  if (subtitles.length === 0) {
    if (needLogin) {
      console.error("Warning: \u6B64\u89C6\u9891\u5B57\u5E55\u9700\u8981\u767B\u5F55\u624D\u80FD\u8BBF\u95EE\uFF0Cfallback \u5230 Whisper ASR");
    }
    return null;
  }
  let target = subtitles[0];
  if (lang) {
    const matched = subtitles.find((s) => s.lan === lang) ?? subtitles[0];
    if (matched.lan !== lang) {
      console.error(`Warning: --lang "${lang}" \u672A\u627E\u5230\uFF0C\u4F7F\u7528 "${matched.lan}"\u3002\u53EF\u7528: ${subtitles.map((s) => s.lan).join(", ")}`);
    }
    target = matched;
  }
  const subtitleUrl = target.subtitle_url;
  if (!subtitleUrl) {
    console.error("Warning: subtitle_url \u4E3A\u7A7A\uFF0C\u53EF\u80FD\u9700\u8981\u767B\u5F55\u6216\u98CE\u63A7\uFF0Cfallback \u5230 Whisper");
    return null;
  }
  const finalUrl = subtitleUrl.startsWith("//") ? "https:" + subtitleUrl : subtitleUrl;
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
    throw new TranscribeError(`\u5B57\u5E55 JSON \u83B7\u53D6\u5931\u8D25: ${subResult.error}`);
  }
  const rawItems = subResult?.data ?? [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const segments = rawItems.map((item) => ({
    start: Number(item.from ?? 0),
    end: Number(item.to ?? 0),
    text: String(item.content ?? "")
  }));
  const source = target.lan?.startsWith("ai-") ? "auto_caption" : "manual_caption";
  return { segments, source };
}
function extractBvid(input) {
  const match = input.match(/BV[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || "").join("").slice(0, 32);
}
async function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1e3);
  const allParams = { ...params, wts: String(wts) };
  const sorted = {};
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, "");
  }
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, "%20");
  const wRid = createHash("md5").update(query + mixinKey).digest("hex");
  sorted.w_rid = wRid;
  return sorted;
}
export {
  extractBvid,
  normalizeBilibiliUrl
};
