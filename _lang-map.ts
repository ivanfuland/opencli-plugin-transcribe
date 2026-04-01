/**
 * Language code mapping: platform codes → Whisper language codes.
 * Unmapped codes pass through unchanged.
 */

const LANG_MAP: Record<string, string> = {
  'zh-Hans': 'zh',
  'zh-Hant': 'zh',
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'zh-HK': 'zh',
  'en-US': 'en',
  'en-GB': 'en',
  'en-AU': 'en',
  'ja-JP': 'ja',
  'ko-KR': 'ko',
  'fr-FR': 'fr',
  'de-DE': 'de',
  'es-ES': 'es',
  'es-MX': 'es',
  'pt-BR': 'pt',
  'pt-PT': 'pt',
  'ru-RU': 'ru',
  'ar-SA': 'ar',
  'hi-IN': 'hi',
  'it-IT': 'it',
  'nl-NL': 'nl',
  'pl-PL': 'pl',
  'tr-TR': 'tr',
  'vi-VN': 'vi',
  'th-TH': 'th',
  'id-ID': 'id',
  'ms-MY': 'ms',
};

export function langMap(code: string): string {
  return LANG_MAP[code] ?? code;
}
