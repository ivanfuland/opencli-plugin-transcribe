/**
 * Pick the best YouTube subtitle language from yt-dlp's subtitle/auto-caption
 * language lists. Pure function — no side effects.
 *
 * Priority:
 *   1. user-specified lang (exact manual → prefix manual → exact auto → prefix auto)
 *   2. video's original language (from yt-dlp `info.language`)
 *   3. hard-coded LANG_PREFERENCE fallback
 *   4. first available manual, then first available auto
 *
 * Within 2 and 3 the order is: manual before auto, video language before
 * LANG_PREFERENCE, exact before prefix.
 *
 * Note: yt-dlp's `automatic_captions` contains the video's original ASR caption
 * AND all YouTube auto-translations. Three details are what actually steer the
 * picker toward the original ASR instead of a translated track:
 *
 *   - The video language is resolved (exact, then prefix) before the fallback
 *     table is consulted at all. Running the whole table's *exact* pass first
 *     let an unrelated language win on an exact hit: measured on aircAruvnKk
 *     (`info.language=en-US`, manual has both `en` and `zh`), the picker
 *     returned manual `zh`.
 *   - Suffixed tags also try their base language (`en-US` → `en`). The prefix
 *     rule compares whole keys, so it covers `en-US` against a bare `en` key
 *     but not against `en-CA` — only the base form reaches those.
 *   - Auto tracks prefer the `-orig` variant: it is the original ASR, while the
 *     unsuffixed key may be a YouTube auto-translation.
 */

/** Fallback preference when neither userLang nor videoLang match anything. */
export const LANG_PREFERENCE = ['zh-Hans', 'zh-Hant', 'zh', 'en', 'ja', 'ko'];

/** 后缀标签的基语言：`en-US` → `en`、`zh-Hans` → `zh`；无后缀时为空。 */
function baseOf(lang: string): string[] {
  const dash = lang.indexOf('-');
  if (dash <= 0) return [];
  const base = lang.slice(0, dash);
  return base ? [base] : [];
}

/** 人工轨的候选顺序：本体 → 基语言。 */
function manualKeys(lang: string): string[] {
  return [lang, ...baseOf(lang)];
}

/** 自动轨的候选顺序：每个键先要 `-orig`（原始 ASR），再要同名普通轨。 */
function autoKeys(lang: string): string[] {
  return manualKeys(lang).flatMap(k => [`${k}-orig`, k]);
}

/** 按出现顺序去重，避免基语言与表中某项重复时多跑一轮。 */
function dedup(keys: string[]): string[] {
  return [...new Set(keys)];
}

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

  const videoManual = videoLang ? dedup(manualKeys(videoLang)) : [];
  const videoAuto = videoLang ? dedup(autoKeys(videoLang)) : [];
  const tableManual = dedup(LANG_PREFERENCE.flatMap(manualKeys));
  const tableAuto = dedup(LANG_PREFERENCE.flatMap(autoKeys));

  /** 在 langs 里按 keys 顺序找，精确匹配优先于前缀匹配。 */
  const pickFrom = (
    langs: string[],
    keys: string[],
    isAuto: boolean,
  ): { lang: string; isAuto: boolean } | null => {
    for (const exact of [true, false]) {
      for (const k of keys) {
        const hit = exact
          ? langs.find(l => l === k)
          : langs.find(l => l.startsWith(k) || k.startsWith(l));
        if (hit) return { lang: hit, isAuto };
      }
    }
    return null;
  };

  return (
    pickFrom(manualLangs, videoManual, false) ??
    pickFrom(manualLangs, tableManual, false) ??
    pickFrom(autoLangs, videoAuto, true) ??
    pickFrom(autoLangs, tableAuto, true) ??
    (manualLangs.length > 0 ? { lang: manualLangs[0], isAuto: false } : null) ??
    (autoLangs.length > 0 ? { lang: autoLangs[0], isAuto: true } : null)
  );
}
