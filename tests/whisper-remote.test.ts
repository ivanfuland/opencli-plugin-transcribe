import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { transcribeWithWhisper } from '../_whisper.js';
import { TranscribeError } from '../_errors.js';

const JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const priorBackend = process.env.TRANSCRIBE_WHISPER_BACKEND;
const priorUrl = process.env.TRANSCRIBE_REMOTE_URL;
const priorModel = process.env.TRANSCRIBE_WHISPER_MODEL;
const priorConfigFile = process.env.TRANSCRIBE_CONFIG_FILE;
const servers: Server[] = [];
const dirs: string[] = [];

async function audio(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-whisper-remote-'));
  dirs.push(dir);
  const path = join(dir, 'audio.wav');
  await writeFile(path, Buffer.from('RIFFsynthetic-wave-bytes'));
  return path;
}

async function configFile(content: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-whisper-cfg-'));
  dirs.push(dir);
  const file = join(dir, 'transcribe.json');
  await writeFile(file, JSON.stringify(content));
  return file;
}

async function serve(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (priorBackend === undefined) delete process.env.TRANSCRIBE_WHISPER_BACKEND;
  else process.env.TRANSCRIBE_WHISPER_BACKEND = priorBackend;
  if (priorUrl === undefined) delete process.env.TRANSCRIBE_REMOTE_URL;
  else process.env.TRANSCRIBE_REMOTE_URL = priorUrl;
  if (priorModel === undefined) delete process.env.TRANSCRIBE_WHISPER_MODEL;
  else process.env.TRANSCRIBE_WHISPER_MODEL = priorModel;
  if (priorConfigFile === undefined) delete process.env.TRANSCRIBE_CONFIG_FILE;
  else process.env.TRANSCRIBE_CONFIG_FILE = priorConfigFile;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('remote Whisper HTTP contract', () => {
  it('streams WAV bytes and converts completed segments through queued and running', async () => {
    let uploaded = Buffer.alloc(0);
    let polls = 0;
    const longQueue = process.env.TRANSCRIBE_TEST_LONG_QUEUE === '1';
    const completeAtPoll = longQueue ? 7 : 2;
    const startedAt = Date.now();
    process.env.TRANSCRIBE_REMOTE_URL = await serve(async (req, res) => {
      if (req.method === 'POST') {
        expect(req.url).toBe('/api/whisper/jobs?lang=zh');
        expect(req.headers['content-type']).toBe('audio/wav');
        for await (const chunk of req) uploaded = Buffer.concat([uploaded, chunk]);
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
        return;
      }
      expect(req.url).toBe(`/api/whisper/jobs/${JOB_ID}`);
      const status = polls === 0 ? 'queued' : polls < completeAtPoll ? 'running' : 'completed';
      polls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        status,
        ...(status === 'completed' ? { model: 'turbo', segments: [{ start: 1, end: 2.5, text: ' hello ' }] } : {}),
      }));
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    // 客户端配的是 large-v3，服务端实际用的是 turbo：标签必须跟服务端走
    process.env.TRANSCRIBE_WHISPER_MODEL = 'large-v3';
    const { segments, source } = await transcribeWithWhisper(await audio(), tmpdir(), 'zh');
    expect(uploaded).toEqual(Buffer.from('RIFFsynthetic-wave-bytes'));
    expect(polls).toBe(completeAtPoll + 1);
    if (longQueue) expect(Date.now() - startedAt).toBeGreaterThan(60_000);
    expect(segments).toEqual([{ start: 1, end: 2.5, text: 'hello' }]);
    expect(source).toBe('whisper_turbo');
  }, process.env.TRANSCRIBE_TEST_LONG_QUEUE === '1' ? 90_000 : 30_000);

  it('reports a missing URL before attempting local Whisper', async () => {
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    delete process.env.TRANSCRIBE_REMOTE_URL;
    await expect(transcribeWithWhisper(await audio(), tmpdir())).rejects.toThrow(/TRANSCRIBE_REMOTE_URL/);
  });

  it('fails on server failure and missing jobs', async () => {
    let status = 200;
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else if (status === 404) {
        res.writeHead(404).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'failed', error: 'synthetic failure' }));
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    await expect(transcribeWithWhisper(await audio(), tmpdir())).rejects.toThrow(/synthetic failure/);
    status = 404;
    await expect(transcribeWithWhisper(await audio(), tmpdir())).rejects.toThrow(/404|missing|not found/i);
  });

  it('rejects completed responses with malformed segment data', async () => {
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          status: 'completed', segments: [{ start: 'bad', end: 2, text: null }],
        }));
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    await expect(transcribeWithWhisper(await audio(), tmpdir())).rejects.toThrow(/invalid segment/);
  });

  it('fails immediately when the remote host refuses connection', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.TRANSCRIBE_REMOTE_URL = `http://127.0.0.1:${address.port}`;
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    await expect(transcribeWithWhisper(await audio(), tmpdir())).rejects.toBeInstanceOf(TranscribeError);
  });

  it('aborts a hung status request when its own deadline expires', async () => {
    let closeStatusResponse: (() => void) | undefined;
    const statusClosed = new Promise<void>(resolve => { closeStatusResponse = resolve; });
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else {
        res.on('close', () => closeStatusResponse?.());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    await expect(transcribeWithWhisper(await audio(), tmpdir(), undefined, 1)).rejects.toThrow(/timed out/);
    await statusClosed;
  }, 5_000);

  it('stops polling when the command deadline from the download stage aborts', async () => {
    let closeStatusResponse: (() => void) | undefined;
    const statusClosed = new Promise<void>(resolve => { closeStatusResponse = resolve; });
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else {
        res.on('close', () => closeStatusResponse?.());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    const commandDeadline = new AbortController();
    const timer = setTimeout(() => commandDeadline.abort(new Error('deadline exceeded')), 200);
    try {
      await expect(transcribeWithWhisper(await audio(), tmpdir(), undefined, 25200, commandDeadline.signal))
        .rejects.toThrow(/timed out/);
      await statusClosed;
    } finally {
      clearTimeout(timer);
    }
  }, 5_000);

  it('labels the transcript with the server-reported model, not the client config', async () => {
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          status: 'completed',
          model: 'large-v3-turbo',
          segments: [{ start: 0, end: 1, text: 'hi' }],
        }));
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    process.env.TRANSCRIBE_WHISPER_MODEL = 'large-v3';

    const { source } = await transcribeWithWhisper(await audio(), tmpdir());

    expect(source).toBe('whisper_large_v3_turbo');
  });

  it('falls back to whisper_unknown when the server reports no model', async () => {
    process.env.TRANSCRIBE_REMOTE_URL = await serve((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          status: 'completed',
          segments: [{ start: 0, end: 1, text: 'hi' }],
        }));
      }
    });
    process.env.TRANSCRIBE_WHISPER_BACKEND = 'remote';
    process.env.TRANSCRIBE_WHISPER_MODEL = 'large-v3';

    const { source } = await transcribeWithWhisper(await audio(), tmpdir());

    // 不拿客户端配置顶替——那个值可能完全是错的
    expect(source).toBe('whisper_unknown');
  });
  it('takes the remote path from the config file alone, with no TRANSCRIBE_* in the environment', async () => {
    // 这就是加配置文件要证的那件事：调用方的环境里什么都没有，行为仍然一致。
    let uploaded = Buffer.alloc(0);
    const base = await serve(async (req, res) => {
      if (req.method === 'POST') {
        for await (const chunk of req) uploaded = Buffer.concat([uploaded, chunk]);
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobId: JOB_ID }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        status: 'completed',
        model: 'turbo',
        segments: [{ start: 0, end: 1, text: 'hi' }],
      }));
    });

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TRANSCRIBE_')) delete process.env[key];
    }
    process.env.TRANSCRIBE_CONFIG_FILE = await configFile({ backend: 'remote', remoteUrl: base, model: 'turbo' });

    const { segments, source } = await transcribeWithWhisper(await audio(), tmpdir(), 'zh');

    expect(uploaded.byteLength).toBeGreaterThan(0); // 真的走到了上传
    expect(segments).toEqual([{ start: 0, end: 1, text: 'hi' }]);
    expect(source).toBe('whisper_turbo');
  }, 30_000);
});
