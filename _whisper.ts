/**
 * Whisper transcription via CLI subprocess for opencli-plugin-transcribe.
 * Uses whisper large-v3 by default; set TRANSCRIBE_WHISPER_MODEL to pick another
 * model (e.g. turbo, small) on GPUs that cannot hold large-v3.
 * Backend: openai-whisper CLI by default; faster-whisper runs _faster_whisper.py;
 * remote sends audio to a Whisper job service without loading a local model.
 * GPU fallback: CUDA → CPU on failure.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFasterWhisper, checkWhisper } from './_deps.js';
import { effectiveEnv } from './_config.js';
import { TranscribeError } from './_errors.js';

const WHISPER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const REMOTE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_POLL_INTERVAL_MS = 10_000;
const REMOTE_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 25_200;

export const DEFAULT_WHISPER_MODEL = 'large-v3';
export const DEFAULT_COMPUTE_TYPE = 'int8_float16';
export const DEFAULT_FASTER_WHISPER_PYTHON = 'python3';

// Sits next to this file; the bundled command entries live in the same plugin root.
const FASTER_WHISPER_SCRIPT = fileURLToPath(new URL('./_faster_whisper.py', import.meta.url));

export type WhisperBackend = 'openai' | 'faster-whisper' | 'remote';

/** Model name passed to `whisper --model`: TRANSCRIBE_WHISPER_MODEL if set and non-empty, else large-v3. */
export function resolveWhisperModel(env: NodeJS.ProcessEnv = effectiveEnv()): string {
  const fromEnv = env.TRANSCRIBE_WHISPER_MODEL?.trim();
  return fromEnv ? fromEnv : DEFAULT_WHISPER_MODEL;
}

/**
 * Output `source` value for a Whisper model: `whisper_` plus the model name with every run of
 * non-alphanumerics turned into `_`. The default large-v3 keeps the historical `whisper_large_v3`.
 */
export function whisperSource(model: string): `whisper_${string}` {
  const slug = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `whisper_${slug || 'unknown'}`;
}

/** `source` value for the model TRANSCRIBE_WHISPER_MODEL selects. */
export function resolveWhisperSource(env: NodeJS.ProcessEnv = effectiveEnv()): `whisper_${string}` {
  return whisperSource(resolveWhisperModel(env));
}

/**
 * 日志里显示「这次用哪个转写器」。远端后端下只报 `remote`，不报本地模型名——客户端配的那个模型
 * 根本不会被用到（宿主机没设 `TRANSCRIBE_WHISPER_MODEL`，报它会写成 large-v3，而实际是服务端的
 * turbo）。契约同 `source` 标签：只能报真的。
 */
export function whisperRunLabel(env: NodeJS.ProcessEnv = effectiveEnv()): string {
  return resolveWhisperBackend(env) === 'remote' ? 'remote' : resolveWhisperModel(env);
}

/** TRANSCRIBE_WHISPER_BACKEND: unset or blank means openai; anything other than the three names is an error. */
export function resolveWhisperBackend(env: NodeJS.ProcessEnv = effectiveEnv()): WhisperBackend {
  const fromEnv = env.TRANSCRIBE_WHISPER_BACKEND?.trim().toLowerCase();
  if (!fromEnv || fromEnv === 'openai') return 'openai';
  if (fromEnv === 'faster-whisper') return 'faster-whisper';
  if (fromEnv === 'remote') return 'remote';
  throw new TranscribeError(
    `Unknown TRANSCRIBE_WHISPER_BACKEND "${env.TRANSCRIBE_WHISPER_BACKEND}". Use "openai", "faster-whisper", or "remote".`
  );
}

export interface WhisperCommand {
  backend: WhisperBackend;
  cmd: string;
  /** Arguments without --device, which is appended per attempt (cuda, then cpu). */
  args: string[];
  /** Human-readable model description for the stderr log line. */
  label: string;
}

/** Build the subprocess command for the configured backend. Pure: reads only `env`. */
export function buildWhisperCommand(
  audioPath: string,
  outputDir: string,
  lang?: string,
  env: NodeJS.ProcessEnv = effectiveEnv(),
): WhisperCommand {
  const backend = resolveWhisperBackend(env);
  if (backend === 'remote') throw new TranscribeError('Remote Whisper does not use a local command');
  const model = resolveWhisperModel(env);
  const args = [audioPath, '--model', model];
  if (backend === 'openai') {
    args.push('--output_format', 'json', '--output_dir', outputDir);
    if (lang) args.push('--language', lang);
    return { backend, cmd: 'whisper', args, label: model };
  }
  const computeType = env.TRANSCRIBE_WHISPER_COMPUTE_TYPE?.trim() || DEFAULT_COMPUTE_TYPE;
  const python = env.TRANSCRIBE_FASTER_WHISPER_PYTHON?.trim() || DEFAULT_FASTER_WHISPER_PYTHON;
  args.push('--output_dir', outputDir, '--compute_type', computeType);
  if (lang) args.push('--language', lang);
  return {
    backend,
    cmd: python,
    args: [FASTER_WHISPER_SCRIPT, ...args],
    label: `${model} (faster-whisper, ${computeType})`,
  };
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Whisper 的产出：片段，加上**实际用过的那个模型**的标签。
 *
 * 远端后端的模型由服务端决定，不是客户端配置——客户端那份可能完全是错的（宿主机上没设
 * `TRANSCRIBE_WHISPER_MODEL`，拿默认值当标签会把 M16 跑的 turbo 写成 large_v3，而归档笔记里
 * 这个标签是长期记录）。
 */
export interface WhisperOutcome {
  segments: WhisperSegment[];
  source: `whisper_${string}`;
}

/** 服务端没报告模型时的标签。不拿客户端配置顶替——那个值可能完全是错的。 */
const UNKNOWN_MODEL_SOURCE: `whisper_${string}` = whisperSource('');

/**
 * Run Whisper on an audio file and return parsed segments.
 * @param audioPath Path to WAV file. Use a fixed name (e.g., audio.wav) so output is predictable.
 * @param outputDir Directory where Whisper writes JSON output. Output: <outputDir>/audio.json
 * @param lang Optional Whisper language code (e.g. 'zh', 'en')
 */
export async function transcribeWithWhisper(
  audioPath: string,
  outputDir: string,
  lang?: string,
  timeoutSeconds: number = DEFAULT_COMMAND_TIMEOUT_SECONDS,
  signal?: AbortSignal,
  // 调用方算好的配置快照。默认自己算一次，这样库式调用也不会退回 process.env。
  env: NodeJS.ProcessEnv = effectiveEnv(),
): Promise<WhisperOutcome> {
  if (resolveWhisperBackend(env) === 'remote') return transcribeRemote(audioPath, lang, timeoutSeconds, signal, env);
  const command = buildWhisperCommand(audioPath, outputDir, lang, env);
  if (command.backend === 'openai') await checkWhisper();
  else await checkFasterWhisper(command.cmd);

  const stem = path.basename(audioPath, path.extname(audioPath));
  const jsonOutput = path.join(outputDir, `${stem}.json`);

  process.stderr.write(`[whisper] model: ${command.label}\n`);

  // Try CUDA first, fall back to CPU on CUDA-related errors
  try {
    await runWhisper(command.cmd, [...command.args, '--device', 'cuda']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cuda|CUDA|RuntimeError/i.test(msg)) {
      console.error(`Warning: CUDA failed (${msg.split('\n')[0]}). Retrying on CPU...`);
      await runWhisper(command.cmd, [...command.args, '--device', 'cpu']);
    } else {
      throw err;
    }
  }

  let parsed: { segments?: Array<{ start: number; end: number; text: string }> };
  try {
    const raw = fs.readFileSync(jsonOutput, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TranscribeError(
      `Failed to read Whisper output at ${jsonOutput}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const segments = parsed.segments ?? [];
  return {
    segments: segments.map(s => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text).trim(),
    })),
    // 本地后端：模型就是本地配置选的那个，标签与之一致
    source: resolveWhisperSource(env),
  };
}

function remoteBaseUrl(env: NodeJS.ProcessEnv = effectiveEnv()): string {
  const value = env.TRANSCRIBE_REMOTE_URL?.trim();
  if (!value) throw new TranscribeError('TRANSCRIBE_REMOTE_URL is required for the remote Whisper backend');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TranscribeError('TRANSCRIBE_REMOTE_URL must be an HTTP(S) service URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TranscribeError('TRANSCRIBE_REMOTE_URL must be an HTTP(S) service root without credentials or query');
  }
  return url.href.replace(/\/$/, '');
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, REMOTE_POLL_INTERVAL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function remoteRequest(url: string, init: RequestInit & { duplex?: 'half' }, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)]),
    redirect: 'error',
  });
}

async function transcribeRemote(audioPath: string, lang: string | undefined, timeoutSeconds: number, upstreamSignal?: AbortSignal, env: NodeJS.ProcessEnv = effectiveEnv()): Promise<WhisperOutcome> {
  const base = remoteBaseUrl(env);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TranscribeError('Remote Whisper timeout must be a positive number of seconds');
  }
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Error('deadline exceeded')), timeoutSeconds * 1000);
  const requestSignal = upstreamSignal ? AbortSignal.any([deadline.signal, upstreamSignal]) : deadline.signal;
  const startedAt = Date.now();
  let jobId = '';
  let status = 'queued';
  let upload: fs.ReadStream | undefined;
  const heartbeat = setInterval(() => {
    if (jobId) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      process.stderr.write(`[whisper] remote job ${jobId} ${status} ${elapsed}s\n`);
    }
  }, REMOTE_HEARTBEAT_INTERVAL_MS);

  try {
    const submitUrl = new URL(`${base}/api/whisper/jobs`);
    if (lang) submitUrl.searchParams.set('lang', lang);
    upload = fs.createReadStream(audioPath);
    const submitted = await remoteRequest(submitUrl.href, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: upload as unknown as BodyInit,
      duplex: 'half',
    }, requestSignal);
    if (submitted.status !== 202) throw new TranscribeError(`Remote Whisper submit failed: HTTP ${submitted.status}`);
    const created = await submitted.json() as { jobId?: unknown };
    if (typeof created.jobId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(created.jobId)) {
      throw new TranscribeError('Remote Whisper returned an invalid job ID');
    }
    jobId = created.jobId;

    for (;;) {
      const response = await remoteRequest(`${base}/api/whisper/jobs/${jobId}`, { method: 'GET' }, requestSignal);
      if (response.status === 404) throw new TranscribeError(`Remote Whisper job ${jobId} not found (404)`);
      if (!response.ok) throw new TranscribeError(`Remote Whisper status failed: HTTP ${response.status}`);
      const result = await response.json() as {
        status?: unknown;
        model?: unknown;
        segments?: Array<{ start: unknown; end: unknown; text: unknown }>;
        error?: unknown;
      };
      if (result.status === 'completed') {
        if (!Array.isArray(result.segments)) throw new TranscribeError('Remote Whisper result has no segments');
        // 服务端 GET 的 model 字段就是它实际用的模型；标签用它，不用客户端配置
        const source = typeof result.model === 'string' && result.model.trim()
          ? whisperSource(result.model)
          : UNKNOWN_MODEL_SOURCE;
        const segments = result.segments.map(segment => {
          if (
            !segment || typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 ||
            typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end < segment.start ||
            typeof segment.text !== 'string' || !segment.text.trim()
          ) {
            throw new TranscribeError('Remote Whisper returned an invalid segment');
          }
          return { start: segment.start, end: segment.end, text: segment.text.trim() };
        });
        return { segments, source };
      }
      if (result.status === 'failed') {
        const summary = typeof result.error === 'string' ? result.error.slice(0, 200) : 'unknown error';
        throw new TranscribeError(`Remote Whisper job failed: ${summary}`);
      }
      if (result.status !== 'queued' && result.status !== 'running') {
        throw new TranscribeError('Remote Whisper returned an invalid job status');
      }
      status = result.status;
      await waitForPoll(requestSignal);
    }
  } catch (error) {
    if (error instanceof TranscribeError) throw error;
    if (requestSignal.aborted) throw new TranscribeError('Remote Whisper command timed out');
    throw new TranscribeError(`Remote Whisper request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeat);
    upload?.destroy();
  }
}

async function runWhisper(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const startTime = Date.now();

    // Heartbeat: print elapsed time every 30s so callers know the process is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(`[whisper] transcribing... ${elapsed}s elapsed\n`);
    }, 30_000);

    const proc = execFile(cmd, args, { timeout: WHISPER_TIMEOUT_MS }, (err) => {
      clearInterval(heartbeat);
      if (err) {
        reject(new TranscribeError(
          `Whisper transcription failed: ${stderr.trim() || err.message}`
        ));
      } else {
        resolve();
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  });
}
