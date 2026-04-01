import { describe, it, expect } from 'vitest';
import { formatRaw, formatGrouped } from '../_format.js';
import type { Segment } from '../_format.js';

describe('formatRaw', () => {
  it('happy path: converts segments to indexed rows with formatted timestamps', () => {
    const segments: Segment[] = [
      { start: 0, end: 5.5, text: 'Hello world.' },
      { start: 5.5, end: 12.34, text: 'How are you?' },
    ];
    const rows = formatRaw(segments, 'manual_caption');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ index: 1, start: '0.00s', end: '5.50s', text: 'Hello world.', source: 'manual_caption' });
    expect(rows[1]).toEqual({ index: 2, start: '5.50s', end: '12.34s', text: 'How are you?', source: 'manual_caption' });
  });

  it('edge case: empty segments returns empty array', () => {
    expect(formatRaw([], 'whisper_large_v3')).toEqual([]);
  });

  it('attaches source field correctly', () => {
    const rows = formatRaw([{ start: 0, end: 1, text: 'Hi.' }], 'auto_caption');
    expect(rows[0].source).toBe('auto_caption');
  });
});

describe('formatGrouped', () => {
  it('happy path: merges short segments into paragraphs, timestamp is first segment start', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'Hello' },
      { start: 2, end: 4, text: 'world.' },
    ];
    const rows = formatGrouped(segments, 'manual_caption');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].timestamp).toBe('0:00');
    expect(rows[0].text).toContain('Hello');
    expect(rows[0].source).toBe('manual_caption');
  });

  it('happy path: breaks at sentence boundary (period)', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'First sentence.' },
      { start: 2, end: 4, text: 'Second sentence.' },
    ];
    const rows = formatGrouped(segments, 'auto_caption');
    // Each sentence ends with period so each should flush independently
    expect(rows.length).toBe(2);
    expect(rows[0].text).toBe('First sentence.');
    expect(rows[1].text).toBe('Second sentence.');
  });

  it('happy path: breaks at CJK sentence boundary (。)', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: '第一句。' },
      { start: 2, end: 4, text: '第二句。' },
    ];
    const rows = formatGrouped(segments, 'whisper_large_v3');
    expect(rows.length).toBe(2);
    expect(rows[0].text).toBe('第一句。');
  });

  it('edge case: single segment does not crash', () => {
    const rows = formatGrouped([{ start: 10, end: 15, text: 'Only one.' }], 'manual_caption');
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe('0:10');
  });

  it('edge case: empty segments returns empty array', () => {
    expect(formatGrouped([], 'whisper_large_v3')).toEqual([]);
  });

  it('formats timestamp as HH:MM:SS when over 1 hour', () => {
    const rows = formatGrouped([{ start: 3661, end: 3665, text: 'Late segment.' }], 'auto_caption');
    expect(rows[0].timestamp).toBe('1:01:01');
  });

  it('formats timestamp as MM:SS when under 1 hour', () => {
    const rows = formatGrouped([{ start: 75, end: 80, text: 'Mid segment.' }], 'auto_caption');
    expect(rows[0].timestamp).toBe('1:15');
  });
});
