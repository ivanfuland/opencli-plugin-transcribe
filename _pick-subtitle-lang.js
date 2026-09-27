const LANG_PREFERENCE = ["zh-Hans", "zh-Hant", "zh", "en", "ja", "ko"];
function baseOf(lang) {
  const dash = lang.indexOf("-");
  if (dash <= 0) return [];
  const base = lang.slice(0, dash);
  return base ? [base] : [];
}
function manualKeys(lang) {
  return [lang, ...baseOf(lang)];
}
function autoKeys(lang) {
  return manualKeys(lang).flatMap((k) => [`${k}-orig`, k]);
}
function dedup(keys) {
  return [...new Set(keys)];
}
function pickSubtitleLang(manualLangs, autoLangs, userLang, videoLang) {
  if (userLang) {
    const exactManual = manualLangs.find((l) => l === userLang);
    if (exactManual) return { lang: exactManual, isAuto: false };
    const prefixManual = manualLangs.find((l) => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixManual) return { lang: prefixManual, isAuto: false };
    const exactAuto = autoLangs.find((l) => l === userLang);
    if (exactAuto) return { lang: exactAuto, isAuto: true };
    const prefixAuto = autoLangs.find((l) => l.startsWith(userLang) || userLang.startsWith(l));
    if (prefixAuto) return { lang: prefixAuto, isAuto: true };
  }
  const videoManual = videoLang ? dedup(manualKeys(videoLang)) : [];
  const videoAuto = videoLang ? dedup(autoKeys(videoLang)) : [];
  const tableManual = dedup(LANG_PREFERENCE.flatMap(manualKeys));
  const tableAuto = dedup(LANG_PREFERENCE.flatMap(autoKeys));
  const pickFrom = (langs, keys, isAuto) => {
    for (const exact of [true, false]) {
      for (const k of keys) {
        const hit = exact ? langs.find((l) => l === k) : langs.find((l) => l.startsWith(k) || k.startsWith(l));
        if (hit) return { lang: hit, isAuto };
      }
    }
    return null;
  };
  return pickFrom(manualLangs, videoManual, false) ?? pickFrom(manualLangs, tableManual, false) ?? pickFrom(autoLangs, videoAuto, true) ?? pickFrom(autoLangs, tableAuto, true) ?? (manualLangs.length > 0 ? { lang: manualLangs[0], isAuto: false } : null) ?? (autoLangs.length > 0 ? { lang: autoLangs[0], isAuto: true } : null);
}
export {
  LANG_PREFERENCE,
  pickSubtitleLang
};
