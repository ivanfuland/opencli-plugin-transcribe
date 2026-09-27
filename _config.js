import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const CONFIG_KEYS = {
  backend: "TRANSCRIBE_WHISPER_BACKEND",
  remoteUrl: "TRANSCRIBE_REMOTE_URL",
  model: "TRANSCRIBE_WHISPER_MODEL",
  fasterWhisperPython: "TRANSCRIBE_FASTER_WHISPER_PYTHON",
  computeType: "TRANSCRIBE_WHISPER_COMPUTE_TYPE"
};
function defaultConfigPath() {
  return path.join(os.homedir(), ".config", "opencli", "transcribe.json");
}
function configPath(env = process.env) {
  const fromEnv = env.TRANSCRIBE_CONFIG_FILE?.trim();
  return fromEnv || defaultConfigPath();
}
function loadConfigFile(filePath = configPath()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[transcribe] config file is not valid JSON, ignoring it: ${filePath}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) out[envName] = value.trim();
  }
  return out;
}
function effectiveEnv(env = process.env) {
  const merged = { ...env };
  for (const [name, value] of Object.entries(loadConfigFile(configPath(env)))) {
    if (!merged[name]?.trim()) merged[name] = value;
  }
  return merged;
}
export {
  configPath,
  defaultConfigPath,
  effectiveEnv,
  loadConfigFile
};
