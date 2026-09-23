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
async function checkFasterWhisper(python) {
  try {
    await execFileAsync(python, ["-c", "import faster_whisper"]);
  } catch (err) {
    throw new TranscribeError(
      `faster-whisper not importable with ${python}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. Install: pip install faster-whisper, or point TRANSCRIBE_FASTER_WHISPER_PYTHON at the venv python that has it`
    );
  }
}
async function checkFfmpeg() {
  await checkDep("ffmpeg", "Install: brew install ffmpeg  or  apt install ffmpeg");
}
export {
  checkDep,
  checkFasterWhisper,
  checkFfmpeg,
  checkWhisper,
  checkYtDlp
};
