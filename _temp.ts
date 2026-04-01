/**
 * Temporary directory management for opencli-plugin-transcribe.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-transcribe-'));
}

export function cleanupTempDir(dir: string, keepAudio: boolean): void {
  if (keepAudio) {
    console.error(`Audio kept at: ${dir}`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — ignore errors
  }
}

/**
 * Register SIGINT/SIGTERM hooks to clean up on signal interruption.
 * Returns a deregister function — call it in the finally block to avoid listener leaks.
 */
export function registerCleanupHook(dir: string): () => void {
  const handler = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
