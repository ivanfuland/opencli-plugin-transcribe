/**
 * Plugin-local error class for opencli-plugin-transcribe.
 *
 * The framework's registry API does not export error classes, so plugins must
 * define their own. The framework renders non-CliError instances as
 * "Unexpected error: <message>", so actionable hints are embedded in the message.
 */

export class TranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscribeError';
  }
}

/** Leads the error message when --subs-only finds no subtitles, so callers can tell it apart from other failures. */
export const NO_SUBTITLES_MARKER = 'TRANSCRIBE_NO_SUBTITLES';

/** --force-asr and --subs-only ask for opposite things. */
export function assertAsrFlags(forceAsr: boolean, subsOnly: boolean): void {
  if (forceAsr && subsOnly) throw new TranscribeError('--force-asr and --subs-only cannot be used together');
}

/** Called where the Whisper fallback would start: with --subs-only, stop instead of downloading audio. */
export function stopIfSubsOnly(subsOnly: boolean): void {
  if (subsOnly) throw new TranscribeError(`${NO_SUBTITLES_MARKER}: no subtitles found; --subs-only skips the Whisper fallback`);
}
