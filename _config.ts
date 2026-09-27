/**
 * 用户级配置文件。目的只有一个：让「这台机器的听写走哪」是**机器属性**，而不是「谁启动了这个
 * 进程」的属性。
 *
 * 环境变量在进程启动那一刻就从父进程抄定了，所以同一条命令在终端里、在 agent 的 Bash 里、在
 * `ssh host '...'` 里、在 cron 里看到的后端可能各不相同。2026-09-27 真实翻车两次：一次是
 * 从旧窗格起的会话，一次是非交互 ssh。配置文件在运行时读，任何调用方看到的都一样。
 *
 * 路径：`TRANSCRIBE_CONFIG_FILE` 指向的文件；未设时 `~/.config/opencli/transcribe.json`。
 * 优先级：**非空**的环境变量 > 配置文件 > 内置默认。空串按未设处理——否则一个空变量就能把
 * 机器级设置顶掉，而那正是我们要消灭的那类问题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置文件里的键 → 环境变量名。只认这几项，其余忽略。 */
const CONFIG_KEYS: Record<string, string> = {
  backend: 'TRANSCRIBE_WHISPER_BACKEND',
  remoteUrl: 'TRANSCRIBE_REMOTE_URL',
  model: 'TRANSCRIBE_WHISPER_MODEL',
  fasterWhisperPython: 'TRANSCRIBE_FASTER_WHISPER_PYTHON',
  computeType: 'TRANSCRIBE_WHISPER_COMPUTE_TYPE',
};

/** 默认位置：用户级，不属于任何一次调用。 */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.config', 'opencli', 'transcribe.json');
}

/**
 * 配置文件路径。`TRANSCRIBE_CONFIG_FILE` 可覆盖——测试靠它指向一个不存在的路径，
 * 免得跑测试的人自己那份配置影响结果。
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TRANSCRIBE_CONFIG_FILE?.trim();
  return fromEnv || defaultConfigPath();
}

/**
 * 读配置文件，返回可直接併进环境的那组变量。
 *
 * 文件不存在、读不动、JSON 坏、值不是字符串——一律当作没有。配置文件坏了不该让听写整个失败，
 * 只该退回内置默认（JSON 坏会打一行 stderr，因为那是配置写错了，得让人看见）。
 */
export function loadConfigFile(filePath: string = configPath()): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[transcribe] config file is not valid JSON, ignoring it: ${filePath}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[envName] = value.trim();
  }
  return out;
}

/**
 * 实际生效的配置：配置文件打底，非空的环境变量覆盖。所有解析函数都从这里取值。
 *
 * 每次调用都重读文件（很小的 JSON，一次调用只读几次）。**不做进程内缓存**：缓存会让同一进程里
 * 连续改变环境的测试互相串味，省下的那点 IO 不值这个风险。
 */
export function effectiveEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(loadConfigFile(configPath(env)))) {
    if (!merged[name]?.trim()) merged[name] = value;
  }
  return merged;
}
