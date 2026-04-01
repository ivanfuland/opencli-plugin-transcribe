import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencli-transcribe-"));
}
function cleanupTempDir(dir, keepAudio) {
  if (keepAudio) {
    console.error(`Audio kept at: ${dir}`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function registerCleanupHook(dir) {
  const handler = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
export {
  cleanupTempDir,
  createTempDir,
  registerCleanupHook
};
