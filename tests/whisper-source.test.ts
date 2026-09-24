import { describe, expect, it } from 'vitest';
import { resolveWhisperSource, whisperSource } from '../_whisper.js';

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
