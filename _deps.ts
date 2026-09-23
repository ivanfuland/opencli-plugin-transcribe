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

/** The faster-whisper backend needs a Python interpreter that can import faster_whisper. */
export async function checkFasterWhisper(python: string): Promise<void> {
  try {
    await execFileAsync(python, ['-c', 'import faster_whisper']);
  } catch (err) {
    throw new TranscribeError(
      `faster-whisper not importable with ${python}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}. ` +
      'Install: pip install faster-whisper, or point TRANSCRIBE_FASTER_WHISPER_PYTHON at the venv python that has it'
    );
  }
}

export async function checkFfmpeg(): Promise<void> {
  await checkDep('ffmpeg', 'Install: brew install ffmpeg  or  apt install ffmpeg');
}
