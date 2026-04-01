/**
 * Unit tests for youtube-transcribe command logic.
 * Tests the formatting and flow decisions; external calls (page, yt-dlp, whisper) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseVideoId } from '../youtube-transcribe.js';
import { formatRaw, formatGrouped } from '../_format.js';
import { langMap } from '../_lang-map.js';

// ── parseVideoId ─────────────────────────────────────────────────────────────

describe('parseVideoId', () => {
  it('extracts v= param from watch URL', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtu.be short URL', () => {
    expect(parseVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from /shorts/ URL', () => {
    expect(parseVideoId('https://www.youtube.com/shorts/abc123')).toBe('abc123');
  });

  it('passes through bare video ID unchanged', () => {
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
});

// ── Flow: subtitle available ─────────────────────────────────────────────────

describe('subtitle path output', () => {
  const manualSegments = [
    { start: 0, end: 3, text: 'Hello.' },
    { start: 3, end: 6, text: 'World.' },
  ];

  it('happy path: manual caption returns source=manual_caption in raw mode', () => {
    const rows = formatRaw(manualSegments, 'manual_caption');
    expect(rows[0].source).toBe('manual_caption');
    expect(rows[0].index).toBe(1);
  });

  it('happy path: auto caption returns source=auto_caption', () => {
    const rows = formatRaw(manualSegments, 'auto_caption');
    expect(rows[0].source).toBe('auto_caption');
  });

  it('happy path: grouped mode merges segments', () => {
    const rows = formatGrouped(manualSegments, 'manual_caption');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows.forEach(r => expect(r.source).toBe('manual_caption'));
  });
});

// ── Flow: Whisper fallback ────────────────────────────────────────────────────

describe('whisper path output', () => {
  const whisperSegments = [
    { start: 0, end: 5, text: 'Transcribed by Whisper.' },
  ];

  it('happy path: whisper output has source=whisper_large_v3', () => {
    const rows = formatRaw(whisperSegments, 'whisper_large_v3');
    expect(rows[0].source).toBe('whisper_large_v3');
  });

  it('happy path: --mode raw returns per-segment rows', () => {
    const rows = formatRaw(whisperSegments, 'whisper_large_v3');
    expect(rows).toHaveLength(1);
    expect(rows[0].start).toMatch(/s$/);
    expect(rows[0].end).toMatch(/s$/);
  });

  it('happy path: --mode grouped returns timestamp + text', () => {
    const rows = formatGrouped(whisperSegments, 'whisper_large_v3');
    expect(rows[0].timestamp).toBe('0:00');
    expect(rows[0].text).toContain('Whisper');
  });
});

// ── --lang handling ──────────────────────────────────────────────────────────

describe('--lang handling', () => {
  it('happy path: zh-Hans maps to zh for Whisper', () => {
    expect(langMap('zh-Hans')).toBe('zh');
  });

  it('edge case: unmapped lang passes through unchanged', () => {
    expect(langMap('my-custom')).toBe('my-custom');
  });
});

// ── keep-audio ────────────────────────────────────────────────────────────────

describe('keep-audio behavior', () => {
  it('integration: cleanupTempDir with keepAudio=true logs path instead of deleting', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cleanupTempDir } = await import('../_temp.js');
    cleanupTempDir('/tmp/fake-dir', true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('/tmp/fake-dir'));
    spy.mockRestore();
  });
});
