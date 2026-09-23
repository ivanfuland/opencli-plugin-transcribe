/**
 * --subs-only: stop where the Whisper fallback would start, with a marker callers can match.
 */
import { describe, it, expect } from 'vitest';
import { NO_SUBTITLES_MARKER, assertAsrFlags, stopIfSubsOnly, TranscribeError } from '../_errors.js';

describe('stopIfSubsOnly', () => {
  it('throws a TranscribeError that starts with the marker when subs-only is set', () => {
    expect(() => stopIfSubsOnly(true)).toThrow(TranscribeError);
    expect(() => stopIfSubsOnly(true)).toThrow(new RegExp(`^${NO_SUBTITLES_MARKER}:`));
  });

  it('lets the Whisper fallback proceed without subs-only', () => {
    expect(() => stopIfSubsOnly(false)).not.toThrow();
  });
});

describe('assertAsrFlags', () => {
  it('rejects --force-asr together with --subs-only', () => {
    expect(() => assertAsrFlags(true, true)).toThrow('cannot be used together');
  });

  it('accepts each flag on its own and neither', () => {
    expect(() => assertAsrFlags(true, false)).not.toThrow();
    expect(() => assertAsrFlags(false, true)).not.toThrow();
    expect(() => assertAsrFlags(false, false)).not.toThrow();
  });
});
