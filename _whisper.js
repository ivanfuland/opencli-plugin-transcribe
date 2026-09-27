import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFasterWhisper, checkWhisper } from "./_deps.js";
import { TranscribeError } from "./_errors.js";
const WHISPER_TIMEOUT_MS = 30 * 60 * 1e3;
const REMOTE_REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
const REMOTE_POLL_INTERVAL_MS = 1e4;
const REMOTE_HEARTBEAT_INTERVAL_MS = 3e4;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 25200;
const DEFAULT_WHISPER_MODEL = "large-v3";
const DEFAULT_COMPUTE_TYPE = "int8_float16";
const DEFAULT_FASTER_WHISPER_PYTHON = "python3";
const FASTER_WHISPER_SCRIPT = fileURLToPath(new URL("./_faster_whisper.py", import.meta.url));
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
const UNKNOWN_MODEL_SOURCE = whisperSource("");
async function transcribeWithWhisper(audioPath, outputDir, lang, timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS, signal) {
  if (resolveWhisperBackend() === "remote") return transcribeRemote(audioPath, lang, timeoutSeconds, signal);
  const command = buildWhisperCommand(audioPath, outputDir, lang);
  if (command.backend === "openai") await checkWhisper();
  else await checkFasterWhisper(command.cmd);
  const stem = path.basename(audioPath, path.extname(audioPath));
  const jsonOutput = path.join(outputDir, `${stem}.json`);
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
    const proc = execFile(cmd, args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
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
export {
  DEFAULT_COMPUTE_TYPE,
  DEFAULT_FASTER_WHISPER_PYTHON,
  DEFAULT_WHISPER_MODEL,
  buildWhisperCommand,
  resolveWhisperBackend,
  resolveWhisperModel,
  resolveWhisperSource,
  transcribeWithWhisper,
  whisperRunLabel,
  whisperSource
};
