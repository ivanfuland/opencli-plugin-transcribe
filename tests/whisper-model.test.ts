import { describe, it, expect } from 'vitest';
import { resolveWhisperModel, DEFAULT_WHISPER_MODEL } from '../_whisper.js';

describe('resolveWhisperModel', () => {
  it('defaults to large-v3 when TRANSCRIBE_WHISPER_MODEL is unset', () => {
    expect(resolveWhisperModel({})).toBe('large-v3');
    expect(DEFAULT_WHISPER_MODEL).toBe('large-v3');
  });

  it('uses TRANSCRIBE_WHISPER_MODEL when set', () => {
    expect(resolveWhisperModel({ TRANSCRIBE_WHISPER_MODEL: 'turbo' })).toBe('turbo');
    expect(resolveWhisperModel({ TRANSCRIBE_WHISPER_MODEL: 'small' })).toBe('small');
  });

  it('trims whitespace and falls back to the default when the value is blank', () => {
    expect(resolveWhisperModel({ TRANSCRIBE_WHISPER_MODEL: '  turbo  ' })).toBe('turbo');
    expect(resolveWhisperModel({ TRANSCRIBE_WHISPER_MODEL: '   ' })).toBe('large-v3');
    expect(resolveWhisperModel({ TRANSCRIBE_WHISPER_MODEL: '' })).toBe('large-v3');
  });
});
