// _pick-subtitle-lang.ts
var LANG_PREFERENCE = ["zh-Hans", "zh-Hant", "zh", "en", "ja", "ko"];
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
  const pref = videoLang ? [videoLang, ...LANG_PREFERENCE.filter((l) => l !== videoLang)] : LANG_PREFERENCE;
  for (const p of pref) {
    const manual = manualLangs.find((l) => l === p);
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const manual = manualLangs.find((l) => l.startsWith(p) || p.startsWith(l));
    if (manual) return { lang: manual, isAuto: false };
  }
  for (const p of pref) {
    const auto = autoLangs.find((l) => l === p);
    if (auto) return { lang: auto, isAuto: true };
  }
  for (const p of pref) {
    const auto = autoLangs.find((l) => l.startsWith(p) || p.startsWith(l));
    if (auto) return { lang: auto, isAuto: true };
  }
  if (manualLangs.length > 0) return { lang: manualLangs[0], isAuto: false };
  if (autoLangs.length > 0) return { lang: autoLangs[0], isAuto: true };
  return null;
}
export {
  LANG_PREFERENCE,
  pickSubtitleLang
};
