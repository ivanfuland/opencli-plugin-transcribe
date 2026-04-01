/**
 * Whisper transcription via CLI subprocess for opencli-plugin-transcribe.
 * Uses whisper large-v3 model. GPU fallback: CUDA → CPU on failure.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkWhisper } from './_deps.js';
import { TranscribeError } from './_errors.js';

const WHISPER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
  await checkWhisper();

  const stem = path.basename(audioPath, path.extname(audioPath));
  const jsonOutput = path.join(outputDir, `${stem}.json`);

  const baseArgs = [
    audioPath,
    '--model', 'large-v3',
    '--output_format', 'json',
    '--output_dir', outputDir,
  ];
  if (lang) baseArgs.push('--language', lang);

  // Try CUDA first, fall back to CPU on CUDA-related errors
  try {
    await runWhisper([...baseArgs, '--device', 'cuda']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cuda|CUDA|RuntimeError/i.test(msg)) {
      console.error(`Warning: CUDA failed (${msg.split('\n')[0]}). Retrying on CPU...`);
      await runWhisper([...baseArgs, '--device', 'cpu']);
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

async function runWhisper(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const startTime = Date.now();

    // Heartbeat: print elapsed time every 30s so callers know the process is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(`[whisper] transcribing... ${elapsed}s elapsed\n`);
    }, 30_000);

    const proc = execFile('whisper', args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
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
