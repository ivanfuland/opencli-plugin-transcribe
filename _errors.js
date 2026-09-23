class TranscribeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscribeError";
  }
}
const NO_SUBTITLES_MARKER = "TRANSCRIBE_NO_SUBTITLES";
function assertAsrFlags(forceAsr, subsOnly) {
  if (forceAsr && subsOnly) throw new TranscribeError("--force-asr and --subs-only cannot be used together");
}
function stopIfSubsOnly(subsOnly) {
  if (subsOnly) throw new TranscribeError(`${NO_SUBTITLES_MARKER}: no subtitles found; --subs-only skips the Whisper fallback`);
}
export {
  NO_SUBTITLES_MARKER,
  TranscribeError,
  assertAsrFlags,
  stopIfSubsOnly
};
