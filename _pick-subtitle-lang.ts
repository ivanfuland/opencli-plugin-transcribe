/**
 * Pick the best YouTube subtitle language from yt-dlp's subtitle/auto-caption
 * language lists. Pure function — no side effects.
 *
 * Priority:
 *   1. user-specified lang (exact manual → prefix manual → exact auto → prefix auto)
 *   2. video's original language (from yt-dlp `info.language`, prepended to preference)
 *   3. hard-coded LANG_PREFERENCE fallback
 *   4. first available manual, then first available auto
 *
 * Note: yt-dlp's `automatic_captions` contains the video's original ASR caption
 * AND all YouTube auto-translations. Passing the original videoLang steers the
 * picker toward the ASR caption instead of a translated one.
 */

/** Fallback preference when neither userLang nor videoLang match anything. */
export const LANG_PREFERENCE = ['zh-Hans', 'zh-Hant', 'zh', 'en', 'ja', 'ko'];

export function pickSubtitleLang(
  manualLangs: string[],
  autoLangs: string[],
  userLang: string,
  videoLang?: string,
): { lang: string; isAuto: boolean } | null {
  if (userLang) {
    const exactManual = manualLangs.find(l => l === userLang);
    if (exactManual) return { lang: exactManual, isAuto: false };

    const prefixManual = manualLangs.find(l => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixManual) return { lang: prefixManual, isAuto: false };

    const exactAuto = autoLangs.find(l => l === userLang);
    if (exactAuto) return { lang: exactAuto, isAuto: true };

    const prefixAuto = autoLangs.find(l => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixAuto) return { lang: prefixAuto, isAuto: true };
  }

  const pref = videoLang
    ? [videoLang, ...LANG_PREFERENCE.filter(l => l !== videoLang)]
    : LANG_PREFERENCE;

  for (const p of pref) {
    const manual = manualLangs.find(l => l === p);
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const manual = manualLangs.find(l => l.startsWith(p) || p.startsWith(l));
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const auto = autoLangs.find(l => l === p);
    if (auto) return { lang: auto, isAuto: true };
  }
  for (const p of pref) {
    const auto = autoLangs.find(l => l.startsWith(p) || p.startsWith(l));
    if (auto) return { lang: auto, isAuto: true };
  }

  if (manualLangs.length > 0) return { lang: manualLangs[0], isAuto: false };
  if (autoLangs.length > 0) return { lang: autoLangs[0], isAuto: true };
  return null;
}
