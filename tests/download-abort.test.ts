import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadAudio } from '../_download.js';

const oldPath = process.env.PATH;
const oldPidFile = process.env.TRANSCRIBE_TEST_CHILD_PID_FILE;
const oldParentPidFile = process.env.TRANSCRIBE_TEST_PARENT_PID_FILE;
const dirs: string[] = [];

async function waitUntil<T>(read: () => Promise<T | undefined>, maxMs = 3_000): Promise<T> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for synthetic child process');
}

async function childIsActive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.+\) [ZX] /.test(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function processGroupId(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
}

afterEach(async () => {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldPidFile === undefined) delete process.env.TRANSCRIBE_TEST_CHILD_PID_FILE;
  else process.env.TRANSCRIBE_TEST_CHILD_PID_FILE = oldPidFile;
  if (oldParentPidFile === undefined) delete process.env.TRANSCRIBE_TEST_PARENT_PID_FILE;
  else process.env.TRANSCRIBE_TEST_PARENT_PID_FILE = oldParentPidFile;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('remote audio download cancellation', () => {
  it.skipIf(process.platform !== 'linux')('kills the converter child when yt-dlp is aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-download-abort-'));
    dirs.push(dir);
    const pidFile = join(dir, 'converter.pid');
    const parentPidFile = join(dir, 'downloader.pid');
    const fakeYtDlp = join(dir, 'yt-dlp');
    await writeFile(fakeYtDlp, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TRANSCRIBE_TEST_PARENT_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.TRANSCRIBE_TEST_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`);
    await chmod(fakeYtDlp, 0o755);
    process.env.PATH = `${dir}:${oldPath ?? ''}`;
    process.env.TRANSCRIBE_TEST_CHILD_PID_FILE = pidFile;
    process.env.TRANSCRIBE_TEST_PARENT_PID_FILE = parentPidFile;

    const controller = new AbortController();
    const pending = downloadAudio('https://example.invalid/video', dir, 'chrome', controller.signal);
    const childPid = await waitUntil(async () => {
      try { return Number(await readFile(pidFile, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
    const parentPid = Number(await readFile(parentPidFile, 'utf8'));
    try {
      expect(await childIsActive(childPid)).toBe(true);
      expect(await processGroupId(parentPid)).toBe(parentPid);
      expect(await processGroupId(childPid)).toBe(parentPid);
      controller.abort(new Error('synthetic cancellation'));
      await expect(pending).rejects.toThrow();
      await waitUntil(async () => await childIsActive(childPid) ? undefined : true);
      expect(await childIsActive(childPid)).toBe(false);
    } finally {
      if (await childIsActive(childPid)) process.kill(childPid, 'SIGKILL');
    }
  }, 8_000);
});
