import { describe, it, expect } from 'vitest';
import { buildWhisperCommand, resolveWhisperBackend } from '../_whisper.js';
import { checkFasterWhisper } from '../_deps.js';
import { TranscribeError } from '../_errors.js';
import { getRegistry } from '@jackwener/opencli/registry';
import '../youtube-transcribe.js';
import '../bilibili-transcribe.js';

describe('resolveWhisperBackend', () => {
  it('defaults to openai when unset or blank', () => {
    expect(resolveWhisperBackend({})).toBe('openai');
    expect(resolveWhisperBackend({ TRANSCRIBE_WHISPER_BACKEND: '  ' })).toBe('openai');
  });

  it('accepts the two backend names case-insensitively', () => {
    expect(resolveWhisperBackend({ TRANSCRIBE_WHISPER_BACKEND: 'openai' })).toBe('openai');
    expect(resolveWhisperBackend({ TRANSCRIBE_WHISPER_BACKEND: ' Faster-Whisper ' })).toBe('faster-whisper');
  });

  it('accepts remote without changing the default', () => {
    expect(resolveWhisperBackend({ TRANSCRIBE_WHISPER_BACKEND: ' ReMoTe ' })).toBe('remote');
    expect(resolveWhisperBackend({})).toBe('openai');
  });

  it('error path: rejects an unknown backend name', () => {
    expect(() => resolveWhisperBackend({ TRANSCRIBE_WHISPER_BACKEND: 'whisperx' })).toThrow(TranscribeError);
  });
});

describe('opencli command registration', () => {
  it('gives both transcribe commands an effective seven-hour timeout arg', () => {
    for (const site of ['youtube', 'bilibili']) {
      const command = getRegistry().get(`${site}/transcribe`);
      expect(command?.args.find(arg => arg.name === 'timeout')).toMatchObject({
        name: 'timeout',
        type: 'int',
        default: 25200,
      });
    }
  });
});

describe('buildWhisperCommand', () => {
  it('openai backend keeps the original whisper CLI arguments', () => {
    const c = buildWhisperCommand('/t/audio.wav', '/t', 'zh', {});
    expect(c.cmd).toBe('whisper');
    expect(c.args).toEqual(['/t/audio.wav', '--model', 'large-v3', '--output_format', 'json', '--output_dir', '/t', '--language', 'zh']);
    expect(c.label).toBe('large-v3');
  });

  it('faster-whisper backend runs the bundled script with model and compute type', () => {
    const c = buildWhisperCommand('/t/audio.wav', '/t', undefined, {
      TRANSCRIBE_WHISPER_BACKEND: 'faster-whisper',
      TRANSCRIBE_WHISPER_MODEL: 'turbo',
    });
    expect(c.cmd).toBe('python3');
    expect(c.args[0]).toMatch(/_faster_whisper\.py$/);
    expect(c.args.slice(1)).toEqual(['/t/audio.wav', '--model', 'turbo', '--output_dir', '/t', '--compute_type', 'int8_float16']);
    expect(c.label).toBe('turbo (faster-whisper, int8_float16)');
  });

  it('faster-whisper backend honours python path, compute type and language', () => {
    const c = buildWhisperCommand('/t/audio.wav', '/t', 'en', {
      TRANSCRIBE_WHISPER_BACKEND: 'faster-whisper',
      TRANSCRIBE_FASTER_WHISPER_PYTHON: '/opt/fw/bin/python',
      TRANSCRIBE_WHISPER_COMPUTE_TYPE: 'float16',
    });
    expect(c.cmd).toBe('/opt/fw/bin/python');
    expect(c.args.slice(-4)).toEqual(['--compute_type', 'float16', '--language', 'en']);
  });
});

describe('checkFasterWhisper', () => {
  it('error path: reports the interpreter and the install hint', async () => {
    await expect(checkFasterWhisper('/nonexistent/python-xyz')).rejects.toThrow(/\/nonexistent\/python-xyz.*TRANSCRIBE_FASTER_WHISPER_PYTHON/);
  });
});
