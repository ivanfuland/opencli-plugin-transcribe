/**
 * Audio download via yt-dlp for opencli-plugin-transcribe.
 * yt-dlp internally calls ffmpeg for format conversion.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { checkYtDlp, checkFfmpeg } from './_deps.js';
import { TranscribeError } from './_errors.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Download audio from a URL as WAV using yt-dlp.
 * Returns the path to the downloaded WAV file.
 */
export async function downloadAudio(url: string, outputDir: string, cookiesBrowser = 'chrome'): Promise<string> {
  await checkYtDlp();
  await checkFfmpeg();

  const outputPath = path.join(outputDir, 'audio.wav');

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const proc = execFile(
      'yt-dlp',
      [
        '-x',
        '--audio-format', 'wav',
        '-o', outputPath,
        '--cookies-from-browser', cookiesBrowser,
        '--no-playlist',
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS },
      (err) => {
        if (err) {
          reject(new TranscribeError(
            `yt-dlp download failed: ${stderr.trim() || err.message}`
          ));
        } else {
          resolve();
        }
      },
    );
    // Stream progress to user stderr in real-time
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });

  return outputPath;
}
