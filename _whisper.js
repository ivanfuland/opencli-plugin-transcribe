import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFasterWhisper, checkWhisper } from "./_deps.js";
import { TranscribeError } from "./_errors.js";
const WHISPER_TIMEOUT_MS = 30 * 60 * 1e3;
const DEFAULT_WHISPER_MODEL = "large-v3";
const DEFAULT_COMPUTE_TYPE = "int8_float16";
const DEFAULT_FASTER_WHISPER_PYTHON = "python3";
const FASTER_WHISPER_SCRIPT = fileURLToPath(new URL("./_faster_whisper.py", import.meta.url));
function resolveWhisperModel(env = process.env) {
  const fromEnv = env.TRANSCRIBE_WHISPER_MODEL?.trim();
  return fromEnv ? fromEnv : DEFAULT_WHISPER_MODEL;
}
function resolveWhisperBackend(env = process.env) {
  const fromEnv = env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase();
  if (!fromEnv || fromEnv === "openai") return "openai";
  if (fromEnv === "faster-whisper") return "faster-whisper";
  throw new TranscribeError(
    `Unknown TRANSCRIBE_WHISPER_BACKEND "${env.TRANSCRIBE_WHISPER_BACKEND}". Use "openai" or "faster-whisper".`
  );
}
function buildWhisperCommand(audioPath, outputDir, lang, env = process.env) {
  const backend = resolveWhisperBackend(env);
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
async function transcribeWithWhisper(audioPath, outputDir, lang) {
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
  return segments.map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim()
  }));
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
  transcribeWithWhisper
};
