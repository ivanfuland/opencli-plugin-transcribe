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

  // ── 区域后缀：实测 aircAruvnKk（info.language=en-US，manual 同时有 en 与 zh）──
  // 旧实现返回 manual zh：整张候选表精确匹完才轮到前缀匹配，而 en-US 与裸 en
  // 不精确相等，于是表里排在 en 前面的 zh 先把视频截走了。
  const realManual = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh', 'zh-CN', 'zh-TW'];
  const realAuto = ['en', 'en-orig', 'zh', 'zh-CN', 'zh-Hans', 'zh-Hant', 'zh-TW'];

  it('区域后缀的原语言不再被兜底表截胡（en-US 视频 + manual en/zh → en）', () => {
    expect(pickSubtitleLang(realManual, realAuto, '', 'en-US')).toEqual({ lang: 'en', isAuto: false });
  });

  it('无区域后缀时行为不变（en 视频 + manual en/zh → en）', () => {
    expect(pickSubtitleLang(realManual, realAuto, '', 'en')).toEqual({ lang: 'en', isAuto: false });
  });

  it('自动轨优先 -orig（原始 ASR），同名普通轨排其后', () => {
    expect(pickSubtitleLang([], realAuto, '', 'en')).toEqual({ lang: 'en-orig', isAuto: true });
  });

  it('原语言的模糊匹配优先于兜底表的精确命中（en-US 视频 + en-CA 轨）', () => {
    expect(pickSubtitleLang([], ['en-CA', 'zh-Hans'], '', 'en-US')).toEqual({ lang: 'en-CA', isAuto: true });
  });

  it('英文视频没有 en 轨时选 en-orig，不再退到中文轨', () => {
    expect(pickSubtitleLang([], ['en-orig', 'zh-Hans', 'zh-Hant'], '', 'en')).toEqual({
      lang: 'en-orig',
      isAuto: true,
    });
  });

  it('视频语言未知时兜底表行为不变（manual zh-TW 仍优先于 auto zh-Hans）', () => {
    expect(pickSubtitleLang(['zh-TW'], ['zh-Hans', 'en'], '')).toEqual({ lang: 'zh-TW', isAuto: false });
  });
});
