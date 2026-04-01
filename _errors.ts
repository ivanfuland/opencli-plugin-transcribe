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
