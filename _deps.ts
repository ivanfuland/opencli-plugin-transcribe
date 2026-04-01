/**
 * Dependency detection for opencli-plugin-transcribe.
 * Uses `which` to check if executables are available in PATH.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TranscribeError } from './_errors.js';

const execFileAsync = promisify(execFile);

export async function checkDep(name: string, installHint: string): Promise<void> {
  try {
    await execFileAsync('which', [name]);
  } catch {
    throw new TranscribeError(`${name} not found. ${installHint}`);
  }
}

export async function checkYtDlp(): Promise<void> {
  await checkDep('yt-dlp', 'Install: pip install yt-dlp  or  brew install yt-dlp');
}

export async function checkWhisper(): Promise<void> {
  await checkDep('whisper', 'Install: pip install openai-whisper');
}

export async function checkFfmpeg(): Promise<void> {
  await checkDep('ffmpeg', 'Install: brew install ffmpeg  or  apt install ffmpeg');
}
