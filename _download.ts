/**
 * Audio download for opencli-plugin-transcribe.
 * Primary: ffmpeg from a direct streaming URL (e.g. InnerTube player API).
 * Fallback: yt-dlp (requires working cookie access).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { checkYtDlp, checkFfmpeg } from './_deps.js';
import { TranscribeError } from './_errors.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Download audio from a direct streaming URL using ffmpeg.
 * Used when a signed streaming URL is already available (e.g. from InnerTube player API),
 * bypassing the need for yt-dlp cookie extraction.
 */
export async function downloadAudioFromUrl(streamUrl: string, outputDir: string): Promise<string> {
  await checkFfmpeg();

  const outputPath = path.join(outputDir, 'audio.wav');

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const proc = execFile(
      'ffmpeg',
      ['-y', '-i', streamUrl, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath],
      { timeout: DOWNLOAD_TIMEOUT_MS },
      (err) => {
        if (err) {
          reject(new TranscribeError(
            `ffmpeg download failed: ${stderr.trim() || err.message}`
          ));
        } else {
          resolve();
        }
      },
    );
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });

  return outputPath;
}

/**
 * Download audio from a URL as WAV using yt-dlp.
 * Returns the path to the downloaded WAV file.
 */
export async function downloadAudio(url: string, outputDir: string, cookiesBrowser = 'chrome+GNOMEKEYRING'): Promise<string> {
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
        '--remote-components', 'ejs:github',
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
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });

  return outputPath;
}
