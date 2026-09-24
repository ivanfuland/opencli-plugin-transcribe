/**
 * Whisper transcription via CLI subprocess for opencli-plugin-transcribe.
 * Uses whisper large-v3 by default; set TRANSCRIBE_WHISPER_MODEL to pick another
 * model (e.g. turbo, small) on GPUs that cannot hold large-v3.
 * Backend: openai-whisper CLI by default; TRANSCRIBE_WHISPER_BACKEND=faster-whisper runs
 * _faster_whisper.py (CTranslate2, int8 quantization) instead.
 * GPU fallback: CUDA → CPU on failure.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFasterWhisper, checkWhisper } from './_deps.js';
import { TranscribeError } from './_errors.js';

const WHISPER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const DEFAULT_WHISPER_MODEL = 'large-v3';
export const DEFAULT_COMPUTE_TYPE = 'int8_float16';
export const DEFAULT_FASTER_WHISPER_PYTHON = 'python3';

// Sits next to this file; the bundled command entries live in the same plugin root.
const FASTER_WHISPER_SCRIPT = fileURLToPath(new URL('./_faster_whisper.py', import.meta.url));

export type WhisperBackend = 'openai' | 'faster-whisper';

/** Model name passed to `whisper --model`: TRANSCRIBE_WHISPER_MODEL if set and non-empty, else large-v3. */
export function resolveWhisperModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TRANSCRIBE_WHISPER_MODEL?.trim();
  return fromEnv ? fromEnv : DEFAULT_WHISPER_MODEL;
}

/**
 * Output `source` value for a Whisper model: `whisper_` plus the model name with every run of
 * non-alphanumerics turned into `_`. The default large-v3 keeps the historical `whisper_large_v3`.
 */
export function whisperSource(model: string): `whisper_${string}` {
  const slug = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `whisper_${slug || 'unknown'}`;
}

/** `source` value for the model TRANSCRIBE_WHISPER_MODEL selects. */
export function resolveWhisperSource(env: NodeJS.ProcessEnv = process.env): `whisper_${string}` {
  return whisperSource(resolveWhisperModel(env));
}

/** TRANSCRIBE_WHISPER_BACKEND: unset or blank means openai; anything other than the two names is an error. */
export function resolveWhisperBackend(env: NodeJS.ProcessEnv = process.env): WhisperBackend {
  const fromEnv = env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase();
  if (!fromEnv || fromEnv === 'openai') return 'openai';
  if (fromEnv === 'faster-whisper') return 'faster-whisper';
  throw new TranscribeError(
    `Unknown TRANSCRIBE_WHISPER_BACKEND "${env.TRANSCRIBE_WHISPER_BACKEND}". Use "openai" or "faster-whisper".`
  );
}

export interface WhisperCommand {
  backend: WhisperBackend;
  cmd: string;
  /** Arguments without --device, which is appended per attempt (cuda, then cpu). */
  args: string[];
  /** Human-readable model description for the stderr log line. */
  label: string;
}

/** Build the subprocess command for the configured backend. Pure: reads only `env`. */
export function buildWhisperCommand(
  audioPath: string,
  outputDir: string,
  lang?: string,
  env: NodeJS.ProcessEnv = process.env,
): WhisperCommand {
  const backend = resolveWhisperBackend(env);
  const model = resolveWhisperModel(env);
  const args = [audioPath, '--model', model];
  if (backend === 'openai') {
    args.push('--output_format', 'json', '--output_dir', outputDir);
    if (lang) args.push('--language', lang);
    return { backend, cmd: 'whisper', args, label: model };
  }
  const computeType = env.TRANSCRIBE_WHISPER_COMPUTE_TYPE?.trim() || DEFAULT_COMPUTE_TYPE;
  const python = env.TRANSCRIBE_FASTER_WHISPER_PYTHON?.trim() || DEFAULT_FASTER_WHISPER_PYTHON;
  args.push('--output_dir', outputDir, '--compute_type', computeType);
  if (lang) args.push('--language', lang);
  return {
    backend,
    cmd: python,
    args: [FASTER_WHISPER_SCRIPT, ...args],
    label: `${model} (faster-whisper, ${computeType})`,
  };
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Run Whisper on an audio file and return parsed segments.
 * @param audioPath Path to WAV file. Use a fixed name (e.g., audio.wav) so output is predictable.
 * @param outputDir Directory where Whisper writes JSON output. Output: <outputDir>/audio.json
 * @param lang Optional Whisper language code (e.g. 'zh', 'en')
 */
export async function transcribeWithWhisper(
  audioPath: string,
  outputDir: string,
  lang?: string,
): Promise<WhisperSegment[]> {
  const command = buildWhisperCommand(audioPath, outputDir, lang);
  if (command.backend === 'openai') await checkWhisper();
  else await checkFasterWhisper(command.cmd);

  const stem = path.basename(audioPath, path.extname(audioPath));
  const jsonOutput = path.join(outputDir, `${stem}.json`);

  process.stderr.write(`[whisper] model: ${command.label}\n`);

  // Try CUDA first, fall back to CPU on CUDA-related errors
  try {
    await runWhisper(command.cmd, [...command.args, '--device', 'cuda']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cuda|CUDA|RuntimeError/i.test(msg)) {
      console.error(`Warning: CUDA failed (${msg.split('\n')[0]}). Retrying on CPU...`);
      await runWhisper(command.cmd, [...command.args, '--device', 'cpu']);
    } else {
      throw err;
    }
  }

  let parsed: { segments?: Array<{ start: number; end: number; text: string }> };
  try {
    const raw = fs.readFileSync(jsonOutput, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TranscribeError(
      `Failed to read Whisper output at ${jsonOutput}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const segments = parsed.segments ?? [];
  return segments.map(s => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim(),
  }));
}

async function runWhisper(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const startTime = Date.now();

    // Heartbeat: print elapsed time every 30s so callers know the process is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(`[whisper] transcribing... ${elapsed}s elapsed\n`);
    }, 30_000);

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
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });
}
