import { describe, it, expect } from 'vitest';
import { langMap } from '../_lang-map.js';

describe('langMap', () => {
  it('maps zh-Hans to zh', () => {
    expect(langMap('zh-Hans')).toBe('zh');
  });

  it('maps zh-CN to zh', () => {
    expect(langMap('zh-CN')).toBe('zh');
  });

  it('maps zh-Hant to zh', () => {
    expect(langMap('zh-Hant')).toBe('zh');
  });

  it('maps en-US to en', () => {
    expect(langMap('en-US')).toBe('en');
  });

  it('maps ja-JP to ja', () => {
    expect(langMap('ja-JP')).toBe('ja');
  });

  it('edge case: unmapped code passes through unchanged', () => {
    expect(langMap('xyz')).toBe('xyz');
  });

  it('edge case: already short code passes through unchanged', () => {
    expect(langMap('en')).toBe('en');
    expect(langMap('zh')).toBe('zh');
  });

  it('edge case: empty string passes through', () => {
    expect(langMap('')).toBe('');
  });
});
