import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, defaultConfigPath, effectiveEnv, loadConfigFile } from '../_config.js';
import { resolveWhisperBackend, whisperRunLabel } from '../_whisper.js';

const dirs: string[] = [];
function configFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-transcribe-config-'));
  dirs.push(dir);
  const file = join(dir, 'transcribe.json');
  writeFileSync(file, content);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('configPath', () => {
  it('默认落在用户级位置', () => {
    expect(configPath({})).toBe(defaultConfigPath());
    expect(defaultConfigPath()).toMatch(/\.config\/opencli\/transcribe\.json$/);
  });

  it('TRANSCRIBE_CONFIG_FILE 可覆盖（测试靠它指向不存在的路径）', () => {
    expect(configPath({ TRANSCRIBE_CONFIG_FILE: '  /tmp/x.json  ' })).toBe('/tmp/x.json');
    expect(configPath({ TRANSCRIBE_CONFIG_FILE: '   ' })).toBe(defaultConfigPath());
  });
});

describe('loadConfigFile', () => {
  it('把配置文件里的键映射成环境变量名', () => {
    const file = configFile(JSON.stringify({ backend: 'remote', remoteUrl: 'http://example:4000', model: 'turbo' }));
    expect(loadConfigFile(file)).toEqual({
      TRANSCRIBE_WHISPER_BACKEND: 'remote',
      TRANSCRIBE_REMOTE_URL: 'http://example:4000',
      TRANSCRIBE_WHISPER_MODEL: 'turbo',
    });
  });

  it('忽略未知键、非字符串值与空串', () => {
    const file = configFile(JSON.stringify({ backend: 'remote', nope: 'x', model: 42, remoteUrl: '   ' }));
    expect(loadConfigFile(file)).toEqual({ TRANSCRIBE_WHISPER_BACKEND: 'remote' });
  });

  it('文件不存在、JSON 坏、不是对象，一律当作没有——配置坏了不该让听写整个失败', () => {
    expect(loadConfigFile('/nonexistent/cc-no-such-config.json')).toEqual({});
    expect(loadConfigFile(configFile('{ not json'))).toEqual({});
    expect(loadConfigFile(configFile('[1,2]'))).toEqual({});
    expect(loadConfigFile(configFile('"just a string"'))).toEqual({});
    expect(loadConfigFile(configFile('null'))).toEqual({});
  });
});

describe('effectiveEnv', () => {
  it('配置文件打底，非空环境变量覆盖', () => {
    const file = configFile(JSON.stringify({ backend: 'remote', model: 'turbo' }));
    const env = effectiveEnv({ TRANSCRIBE_CONFIG_FILE: file, TRANSCRIBE_WHISPER_MODEL: 'small', PATH: '/bin' });
    expect(env.TRANSCRIBE_WHISPER_BACKEND).toBe('remote'); // 来自文件
    expect(env.TRANSCRIBE_WHISPER_MODEL).toBe('small'); // 环境变量赢
    expect(env.PATH).toBe('/bin');
  });

  it('空串的环境变量不覆盖文件——否则一个空变量就能顶掉机器级设置', () => {
    const file = configFile(JSON.stringify({ backend: 'remote' }));
    expect(effectiveEnv({ TRANSCRIBE_CONFIG_FILE: file, TRANSCRIBE_WHISPER_BACKEND: '' }).TRANSCRIBE_WHISPER_BACKEND).toBe('remote');
    expect(effectiveEnv({ TRANSCRIBE_CONFIG_FILE: file, TRANSCRIBE_WHISPER_BACKEND: '   ' }).TRANSCRIBE_WHISPER_BACKEND).toBe('remote');
  });

  it('没有配置文件时就是环境本身', () => {
    const env = effectiveEnv({ TRANSCRIBE_CONFIG_FILE: '/nonexistent/cc-no-such-config.json', SOMETHING: '1' });
    expect(env.SOMETHING).toBe('1');
    expect(env.TRANSCRIBE_WHISPER_BACKEND).toBeUndefined();
  });
});

describe('解析函数会读到配置文件（这就是加它的理由）', () => {
  const KEYS = ['TRANSCRIBE_CONFIG_FILE', 'TRANSCRIBE_WHISPER_BACKEND', 'TRANSCRIBE_REMOTE_URL'] as const;

  it('调用方环境里什么都没有时，后端仍来自机器级的配置文件', () => {
    const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      process.env.TRANSCRIBE_CONFIG_FILE = configFile(
        JSON.stringify({ backend: 'remote', remoteUrl: 'http://example:4000' }),
      );

      // 这正是「谁启动了这个进程」不再影响结果的地方：没有环境变量也照样走远端
      expect(resolveWhisperBackend()).toBe('remote');
      expect(whisperRunLabel()).toBe('remote');
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
