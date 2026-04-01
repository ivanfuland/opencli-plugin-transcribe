/**
 * Output formatting for opencli-plugin-transcribe.
 *
 * Unified output fields:
 *   raw:     { index, start, end, text, source }
 *   grouped: { timestamp, text, source }
 *
 * Patterns: src/clis/youtube/transcript.ts (raw format)
 *           src/clis/youtube/transcript-group.ts (sentence grouping logic)
 */

export type TranscribeSource = 'manual_caption' | 'auto_caption' | 'whisper_large_v3';

export interface RawRow {
  index: number;
  start: string;
  end: string;
  text: string;
  source: TranscribeSource;
}

export interface GroupedRow {
  timestamp: string;
  text: string;
  source: TranscribeSource;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

// Include CJK sentence-ending punctuation: 。！？ (fullwidth: ．！？)
const SENTENCE_END = /[.!?\u3002\uFF01\uFF1F\uFF0E]["'\u2019\u201D)]*\s*$/;
const MAX_GROUP_SPAN_SECONDS = 30;
const TRANSCRIPT_GROUP_GAP_SECONDS = 20;

export function formatRaw(segments: Segment[], source: TranscribeSource): RawRow[] {
  return segments.map((seg, i) => ({
    index: i + 1,
    start: Number(seg.start).toFixed(2) + 's',
    end: Number(seg.end).toFixed(2) + 's',
    text: seg.text,
    source,
  }));
}

export function formatGrouped(segments: Segment[], source: TranscribeSource): GroupedRow[] {
  if (segments.length === 0) return [];

  const groups = groupBySentence(segments);
  return groups.map(g => ({
    timestamp: fmtTime(g.start),
    text: g.text,
    source,
  }));
}

interface GroupedSegment {
  start: number;
  text: string;
}

function groupBySentence(segments: Segment[]): GroupedSegment[] {
  const groups: GroupedSegment[] = [];
  let buffer = '';
  let bufferStart = 0;
  let lastStart = 0;

  const flush = () => {
    if (buffer.trim()) {
      groups.push({ start: bufferStart, text: buffer.trim() });
      buffer = '';
    }
  };

  for (const seg of segments) {
    if (buffer && seg.start - lastStart > TRANSCRIPT_GROUP_GAP_SECONDS) {
      flush();
    }
    if (buffer && seg.start - bufferStart > MAX_GROUP_SPAN_SECONDS) {
      flush();
    }
    if (!buffer) bufferStart = seg.start;
    buffer += (buffer ? ' ' : '') + seg.text;
    lastStart = seg.start;
    if (SENTENCE_END.test(seg.text)) flush();
  }
  flush();
  return groups;
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
