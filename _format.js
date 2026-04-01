const SENTENCE_END = /[.!?\u3002\uFF01\uFF1F\uFF0E]["'\u2019\u201D)]*\s*$/;
const MAX_GROUP_SPAN_SECONDS = 30;
const TRANSCRIPT_GROUP_GAP_SECONDS = 20;
function formatRaw(segments, source) {
  return segments.map((seg, i) => ({
    index: i + 1,
    start: Number(seg.start).toFixed(2) + "s",
    end: Number(seg.end).toFixed(2) + "s",
    text: seg.text,
    source
  }));
}
function formatGrouped(segments, source) {
  if (segments.length === 0) return [];
  const groups = groupBySentence(segments);
  return groups.map((g) => ({
    timestamp: fmtTime(g.start),
    text: g.text,
    source
  }));
}
function groupBySentence(segments) {
  const groups = [];
  let buffer = "";
  let bufferStart = 0;
  let lastStart = 0;
  const flush = () => {
    if (buffer.trim()) {
      groups.push({ start: bufferStart, text: buffer.trim() });
      buffer = "";
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
    buffer += (buffer ? " " : "") + seg.text;
    lastStart = seg.start;
    if (SENTENCE_END.test(seg.text)) flush();
  }
  flush();
  return groups;
}
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
export {
  formatGrouped,
  formatRaw
};
