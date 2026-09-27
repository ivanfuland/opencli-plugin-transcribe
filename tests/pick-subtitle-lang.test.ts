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

  // ── 带后缀的 videoLang：钉的是本函数自己的契约，不是已复现的真实场景 ──
  // YouTube 入口在调用前会用 langMap 归一化 info.language（en-US → en），
  // 所以带后缀的值不是它今天会传进来的形态。字幕表取自一条真实视频的形状。
  const manualEnAndZh = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh', 'zh-CN', 'zh-TW'];
  const autoEnAndOrig = ['en', 'en-orig', 'zh', 'zh-CN', 'zh-Hans', 'zh-Hant', 'zh-TW'];

  it('带后缀的视频语言优先于兜底表的精确命中（videoLang=en-US + manual en/zh → en）', () => {
    expect(pickSubtitleLang(manualEnAndZh, autoEnAndOrig, '', 'en-US')).toEqual({ lang: 'en', isAuto: false });
  });

  it('无后缀时行为不变（en 视频 + manual en/zh → en）', () => {
    expect(pickSubtitleLang(manualEnAndZh, autoEnAndOrig, '', 'en')).toEqual({ lang: 'en', isAuto: false });
  });

  it('自动轨优先 -orig（原始 ASR），同名普通轨排其后', () => {
    expect(pickSubtitleLang([], autoEnAndOrig, '', 'en')).toEqual({ lang: 'en-orig', isAuto: true });
  });

  it('原语言的模糊匹配优先于兜底表的精确命中（videoLang=en-US + en-CA 轨）', () => {
    expect(pickSubtitleLang([], ['en-CA', 'zh-Hans'], '', 'en-US')).toEqual({ lang: 'en-CA', isAuto: true });
  });

  it('英文视频的自动轨里没有 en 时选 en-orig，不再退到中文轨', () => {
    expect(pickSubtitleLang([], ['en-orig', 'zh-Hans', 'zh-Hant'], '', 'en')).toEqual({
      lang: 'en-orig',
      isAuto: true,
    });
  });

  it('视频语言未知时兜底表行为不变（manual zh-TW 仍优先于 auto zh-Hans）', () => {
    expect(pickSubtitleLang(['zh-TW'], ['zh-Hans', 'en'], '')).toEqual({ lang: 'zh-TW', isAuto: false });
  });
});
