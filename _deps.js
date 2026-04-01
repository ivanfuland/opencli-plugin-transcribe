import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TranscribeError } from "./_errors.js";
const execFileAsync = promisify(execFile);
async function checkDep(name, installHint) {
  try {
    await execFileAsync("which", [name]);
  } catch {
    throw new TranscribeError(`${name} not found. ${installHint}`);
  }
}
async function checkYtDlp() {
  await checkDep("yt-dlp", "Install: pip install yt-dlp  or  brew install yt-dlp");
}
async function checkWhisper() {
  await checkDep("whisper", "Install: pip install openai-whisper");
}
async function checkFfmpeg() {
  await checkDep("ffmpeg", "Install: brew install ffmpeg  or  apt install ffmpeg");
}
export {
  checkDep,
  checkFfmpeg,
  checkWhisper,
  checkYtDlp
};
