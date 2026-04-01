import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkWhisper } from "./_deps.js";
import { TranscribeError } from "./_errors.js";
const WHISPER_TIMEOUT_MS = 30 * 60 * 1e3;
async function transcribeWithWhisper(audioPath, outputDir, lang) {
  await checkWhisper();
  const stem = path.basename(audioPath, path.extname(audioPath));
  const jsonOutput = path.join(outputDir, `${stem}.json`);
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
    const proc = execFile("whisper", args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
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
  transcribeWithWhisper
};
