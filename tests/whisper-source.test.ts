import { describe, expect, it } from 'vitest';
import { resolveWhisperSource, whisperRunLabel, whisperSource } from '../_whisper.js';

describe('whisperSource', () => {
  it('keeps the historical value for the default model', () => {
    expect(whisperSource('large-v3')).toBe('whisper_large_v3');
  });

  it('names the model actually used', () => {
    expect(whisperSource('turbo')).toBe('whisper_turbo');
    expect(whisperSource('Distil-Large-v3.5')).toBe('whisper_distil_large_v3_5');
  });
});

describe('resolveWhisperSource', () => {
  it('follows TRANSCRIBE_WHISPER_MODEL', () => {
    expect(resolveWhisperSource({})).toBe('whisper_large_v3');
    expect(resolveWhisperSource({ TRANSCRIBE_WHISPER_MODEL: 'turbo' })).toBe('whisper_turbo');
    expect(resolveWhisperSource({ TRANSCRIBE_WHISPER_MODEL: '  ' })).toBe('whisper_large_v3');
  });
});

describe("whisperRunLabel", () => {
  it("本地后端报本地配置的模型", () => {
    expect(whisperRunLabel({})).toBe('large-v3');
    expect(whisperRunLabel({ TRANSCRIBE_WHISPER_BACKEND: 'faster-whisper', TRANSCRIBE_WHISPER_MODEL: 'turbo' })).toBe('turbo');
  });

  it("远端后端只报 remote，不报本地模型名", () => {
    // 客户端配 large-v3 而服务端实际跑 turbo 时，报本地模型名就是在说谎
    expect(whisperRunLabel({ TRANSCRIBE_WHISPER_BACKEND: 'remote', TRANSCRIBE_WHISPER_MODEL: 'large-v3' })).toBe('remote');
    expect(whisperRunLabel({ TRANSCRIBE_WHISPER_BACKEND: '  REMOTE  ' })).toBe('remote');
  });
});
