/**
 * Unit tests for bilibili-transcribe command logic.
 * Tests URL normalization, field mapping, and formatting decisions.
 * External calls (page, yt-dlp, whisper) are not exercised here.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBilibiliUrl, extractBvid } from '../bilibili-transcribe.js';
import { formatRaw, formatGrouped } from '../_format.js';
import type { Segment } from '../_format.js';

// ── URL normalization ─────────────────────────────────────────────────────────

describe('normalizeBilibiliUrl', () => {
  it('happy path: BVID converts to full URL', () => {
    expect(normalizeBilibiliUrl('BV1xx411c7mD')).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
  });

  it('happy path: full URL passes through unchanged', () => {
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD';
    expect(normalizeBilibiliUrl(url)).toBe(url);
  });

  it('edge case: BVID format starts with BV + alphanumeric', () => {
    // Valid BVID
    expect(normalizeBilibiliUrl('BV1A2B3C4D5')).toContain('BV1A2B3C4D5');
  });
});

// ── Field mapping: Bilibili from/to/content → start/end/text ─────────────────

describe('Bilibili field normalization', () => {
  // Simulate what bilibili-transcribe.ts does internally
  function normalizeBilibiliItems(items: Array<{ from: number; to: number; content: string }>): Segment[] {
    return items.map(item => ({
      start: Number(item.from ?? 0),
      end: Number(item.to ?? 0),
      text: String(item.content ?? ''),
    }));
  }

  it('happy path: normalizes from/to/content to start/end/text', () => {
    const items = [{ from: 0.5, to: 3.2, content: '你好' }];
    const segments = normalizeBilibiliItems(items);
    expect(segments[0]).toEqual({ start: 0.5, end: 3.2, text: '你好' });
  });

  it('happy path: formatRaw uses unified field names', () => {
    const segments = normalizeBilibiliItems([
      { from: 0, to: 5, content: 'Hello.' },
      { from: 5, to: 10, content: 'World.' },
    ]);
    const rows = formatRaw(segments, 'manual_caption');
    expect(rows[0]).toMatchObject({ index: 1, start: '0.00s', end: '5.00s', text: 'Hello.', source: 'manual_caption' });
    expect(rows[1]).toMatchObject({ index: 2, start: '5.00s', end: '10.00s', text: 'World.' });
  });
});

// ── Grouped mode (new feature for Bilibili) ───────────────────────────────────

describe('Bilibili grouped mode', () => {
  it('happy path: grouped mode returns merged paragraphs with timestamp', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: '今天天气不错。' },
      { start: 2, end: 4, text: '适合出门。' },
    ];
    const rows = formatGrouped(segments, 'manual_caption');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].timestamp).toBe('0:00');
    expect(rows[0].source).toBe('manual_caption');
  });

  it('happy path: grouped mode with auto_caption source', () => {
    const segments: Segment[] = [{ start: 10, end: 15, text: '这是 AI 字幕。' }];
    const rows = formatGrouped(segments, 'auto_caption');
    expect(rows[0].source).toBe('auto_caption');
  });
});

// ── Whisper fallback output ───────────────────────────────────────────────────

describe('Whisper fallback', () => {
  it('happy path: force-asr produces whisper_large_v3 source', () => {
    const segments: Segment[] = [{ start: 0, end: 3, text: 'Transcribed.' }];
    const rows = formatRaw(segments, 'whisper_large_v3');
    expect(rows[0].source).toBe('whisper_large_v3');
  });
});

// ── BVID validation ───────────────────────────────────────────────────────────

describe('BVID extraction', () => {
  it('edge case: extracts BVID from full URL', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });

  it('edge case: returns null for non-BVID input', () => {
    expect(extractBvid('https://example.com')).toBeNull();
  });

  it('edge case: bare BVID is extracted correctly', () => {
    expect(extractBvid('BV1abc')).toBe('BV1abc');
  });
});
