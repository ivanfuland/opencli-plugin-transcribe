import { describe, it, expect } from 'vitest';
import { pickSubtitleLang } from '../_pick-subtitle-lang.js';

describe('pickSubtitleLang', () => {
  const autoEnAndTranslations = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'];
  const autoZhAndTranslations = ['zh-Hans', 'en', 'ja'];

  it('userLang overrides everything — exact auto match', () => {
    expect(pickSubtitleLang([], autoEnAndTranslations, 'ja')).toEqual({ lang: 'ja', isAuto: true });
  });

  it('userLang overrides videoLang', () => {
    expect(pickSubtitleLang([], autoEnAndTranslations, 'zh-Hans', 'en')).toEqual({ lang: 'zh-Hans', isAuto: true });
  });

  it('videoLang=en puts en at front — selects en auto over zh-Hans translation', () => {
    expect(pickSubtitleLang([], autoEnAndTranslations, '', 'en')).toEqual({ lang: 'en', isAuto: true });
  });

  it('videoLang=zh-Hans selects zh-Hans auto', () => {
    expect(pickSubtitleLang([], autoZhAndTranslations, '', 'zh-Hans')).toEqual({ lang: 'zh-Hans', isAuto: true });
  });

  it('videoLang prefers manual over auto when both available', () => {
    expect(pickSubtitleLang(['en'], autoEnAndTranslations, '', 'en')).toEqual({ lang: 'en', isAuto: false });
  });

  it('videoLang undefined falls back to old LANG_PREFERENCE (zh-Hans first)', () => {
    expect(pickSubtitleLang([], autoEnAndTranslations, '')).toEqual({ lang: 'zh-Hans', isAuto: true });
  });

  it('videoLang missing from captions falls through to LANG_PREFERENCE', () => {
    expect(pickSubtitleLang([], ['en', 'ja'], '', 'fr')).toEqual({ lang: 'en', isAuto: true });
  });

  it('returns null when no captions available', () => {
    expect(pickSubtitleLang([], [], '', 'en')).toBeNull();
  });
});
