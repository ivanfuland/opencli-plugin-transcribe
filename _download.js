import { execFile } from "node:child_process";
import * as path from "node:path";
import { checkYtDlp, checkFfmpeg } from "./_deps.js";
import { TranscribeError } from "./_errors.js";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
async function downloadAudioFromUrl(streamUrl, outputDir) {
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile(
      "ffmpeg",
      ["-y", "-i", streamUrl, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath],
      { timeout: DOWNLOAD_TIMEOUT_MS },
      (err) => {
        if (err) {
          reject(new TranscribeError(
            `ffmpeg download failed: ${stderr.trim() || err.message}`
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
async function downloadAudio(url, outputDir, cookiesBrowser = "chrome+GNOMEKEYRING") {
  await checkYtDlp();
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile(
      "yt-dlp",
      [
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
export {
  downloadAudio,
  downloadAudioFromUrl
};
