import { execFile, spawn } from "node:child_process";
import * as path from "node:path";
import { checkYtDlp, checkFfmpeg } from "./_deps.js";
import { TranscribeError } from "./_errors.js";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
async function runAbortableDownload(cmd, args, signal, env) {
  if (signal.aborted) throw new TranscribeError(`${cmd} download cancelled`);
  await new Promise((resolve, reject) => {
    let stderr = "";
    let stopped = false;
    const proc = spawn(cmd, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      env
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error("[transcribe] could not stop the audio download process group");
        }
      }
    };
    const timeout = setTimeout(stop, DOWNLOAD_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
    };
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    proc.once("error", (error) => {
      cleanup();
      reject(new TranscribeError(`${cmd} download failed: ${error.message}`));
    });
    proc.once("close", (code) => {
      cleanup();
      if (signal.aborted || stopped || code !== 0) {
        reject(new TranscribeError(`${cmd} download failed: ${signal.aborted ? "cancelled" : stderr.trim() || `exit ${code}`}`));
      } else {
        resolve();
      }
    });
  });
}
async function downloadAudioFromUrl(streamUrl, outputDir, signal) {
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  const args = ["-y", "-i", streamUrl, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath];
  if (signal) {
    await runAbortableDownload("ffmpeg", args, signal);
    return outputPath;
  }
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile(
      "ffmpeg",
      args,
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
async function downloadAudio(url, outputDir, cookiesBrowser = "chrome", signal) {
  await checkYtDlp();
  await checkFfmpeg();
  const outputPath = path.join(outputDir, "audio.wav");
  const args = [
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
  ];
  const env = {
    ...process.env,
    // yt-dlp needs GNOME keyring even when launched outside a full GUI session.
    DESKTOP_SESSION: process.env.DESKTOP_SESSION || "gnome"
  };
  if (signal) {
    await runAbortableDownload("yt-dlp", args, signal, env);
    return outputPath;
  }
  await new Promise((resolve, reject) => {
    let stderr = "";
    const proc = execFile(
      "yt-dlp",
      args,
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        env
      },
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
