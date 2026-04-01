import { createHash } from "node:crypto";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { TranscribeError } from "./_errors.js";
import { downloadAudio } from "./_download.js";
import { transcribeWithWhisper } from "./_whisper.js";
import { formatRaw, formatGrouped } from "./_format.js";
import { createTempDir, cleanupTempDir, registerCleanupHook } from "./_temp.js";
import { langMap } from "./_lang-map.js";
const MIXIN_KEY_ENC_TAB = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];
cli({
  site: "bilibili",
  name: "transcribe",
  description: "\u8F6C\u5F55 Bilibili \u89C6\u9891\uFF08\u5B57\u5E55\u4F18\u5148\uFF0C\u65E0\u5B57\u5E55\u65F6 Whisper large-v3 \u515C\u5E95\uFF09",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  timeoutSeconds: 1800,
  // 30 min — Whisper large-v3 on long videos can take a while
  args: [
    { name: "url", required: true, positional: true, help: "Bilibili \u89C6\u9891 URL \u6216 BVID (\u5982 BV1xxxxxx)" },
    { name: "lang", required: false, help: "\u5B57\u5E55\u8BED\u8A00\u4EE3\u7801 (\u5982 zh-CN, en-US)" },
    { name: "mode", required: false, default: "grouped", choices: ["grouped", "raw"], help: "\u8F93\u51FA\u6A21\u5F0F\uFF1Agrouped \u6216 raw" },
    { name: "force-asr", required: false, type: "boolean", default: false, help: "\u8DF3\u8FC7\u5B57\u5E55\uFF0C\u76F4\u63A5\u4F7F\u7528 Whisper" },
    { name: "keep-audio", required: false, type: "boolean", default: false, help: "\u4FDD\u7559\u4E34\u65F6\u97F3\u9891\u6587\u4EF6" }
  ],
  func: async (page, kwargs) => {
    const inputUrl = String(kwargs.url);
    const lang = kwargs.lang ? String(kwargs.lang) : "";
    const mode = String(kwargs.mode || "grouped");
    const forceAsr = Boolean(kwargs["force-asr"]);
    const keepAudio = Boolean(kwargs["keep-audio"]);
    const videoUrl = normalizeBilibiliUrl(inputUrl);
    const whisperLang = lang ? langMap(lang) : void 0;
    if (!forceAsr && page) {
      try {
        const result = await fetchBilibiliSubtitle(page, videoUrl, inputUrl, lang);
        if (result !== null) {
          const { segments, source } = result;
          return mode === "raw" ? formatRaw(segments, source) : formatGrouped(segments, source);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: subtitle fetch failed (${msg}), falling back to Whisper`);
      }
    }
    console.error("[transcribe] \u672A\u627E\u5230\u5B57\u5E55\uFF0C\u56DE\u843D\u5230 Whisper large-v3 ASR...");
    const tempDir = createTempDir();
    const deregister = registerCleanupHook(tempDir);
    try {
      console.error("[transcribe] \u6B63\u5728\u901A\u8FC7 yt-dlp \u4E0B\u8F7D\u97F3\u9891...");
      const audioPath = await downloadAudio(videoUrl, tempDir);
      console.error("[transcribe] \u97F3\u9891\u5C31\u7EEA\uFF0C\u5F00\u59CB Whisper \u8F6C\u5F55\uFF08\u53EF\u80FD\u9700\u8981\u6570\u5206\u949F\uFF09...");
      const segments = await transcribeWithWhisper(audioPath, tempDir, whisperLang);
      if (segments.length === 0) {
        throw new TranscribeError("Whisper \u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55\u7247\u6BB5\uFF0C\u97F3\u9891\u53EF\u80FD\u8FC7\u77ED\u6216\u65E0\u58F0\u3002");
      }
      return mode === "raw" ? formatRaw(segments, "whisper_large_v3") : formatGrouped(segments, "whisper_large_v3");
    } finally {
      deregister();
      cleanupTempDir(tempDir, keepAudio);
    }
  }
});
function normalizeBilibiliUrl(input) {
  if (input.startsWith("http")) return input;
  if (/^BV[a-zA-Z0-9]+$/.test(input)) {
    return `https://www.bilibili.com/video/${input}`;
  }
  return `https://www.bilibili.com/video/${input}`;
}
async function fetchBilibiliSubtitle(page, videoUrl, originalInput, lang) {
  await page.goto(videoUrl);
  const cid = await page.evaluate(`(async () => {
    const state = window.__INITIAL_STATE__ || {};
    return state?.videoData?.cid;
  })()`);
  if (!cid) {
    throw new TranscribeError("\u65E0\u6CD5\u4ECE\u9875\u9762\u63D0\u53D6 CID\uFF0C\u8BF7\u68C0\u67E5\u89C6\u9891\u9875\u9762\u662F\u5426\u6B63\u5E38\u52A0\u8F7D\u3002\u5982\u9875\u9762\u7ED3\u6784\u5DF2\u53D8\u5316\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6\u3002");
  }
  const bvid = extractBvid(originalInput) || extractBvid(videoUrl) || originalInput;
  const navData = await page.evaluate(`(async () => {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    return await res.json();
  })()`);
  const wbiImg = navData?.data?.wbi_img ?? {};
  const imgKey = (wbiImg.img_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const subKey = (wbiImg.sub_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const signedParams = await wbiSign({ bvid, cid: String(cid) }, imgKey, subKey);
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(signedParams).map(([k, v]) => [k, String(v)]))
  ).toString().replace(/\+/g, "%20");
  const apiUrl = `https://api.bilibili.com/x/player/wbi/v2?${qs}`;
  const payload = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(apiUrl)}, { credentials: 'include' });
    return await res.json();
  })()`);
  if (payload?.code !== 0) {
    throw new TranscribeError(`\u83B7\u53D6\u5B57\u5E55\u5217\u8868\u5931\u8D25: ${payload?.message ?? "unknown"} (${payload?.code ?? "?"})`);
  }
  const needLogin = payload?.data?.need_login_subtitle === true;
  const subtitles = payload?.data?.subtitle?.subtitles ?? [];
  if (subtitles.length === 0) {
    if (needLogin) {
      console.error("Warning: \u6B64\u89C6\u9891\u5B57\u5E55\u9700\u8981\u767B\u5F55\u624D\u80FD\u8BBF\u95EE\uFF0Cfallback \u5230 Whisper ASR");
    }
    return null;
  }
  let target = subtitles[0];
  if (lang) {
    const matched = subtitles.find((s) => s.lan === lang) ?? subtitles[0];
    if (matched.lan !== lang) {
      console.error(`Warning: --lang "${lang}" \u672A\u627E\u5230\uFF0C\u4F7F\u7528 "${matched.lan}"\u3002\u53EF\u7528: ${subtitles.map((s) => s.lan).join(", ")}`);
    }
    target = matched;
  }
  const subtitleUrl = target.subtitle_url;
  if (!subtitleUrl) {
    console.error("Warning: subtitle_url \u4E3A\u7A7A\uFF0C\u53EF\u80FD\u9700\u8981\u767B\u5F55\u6216\u98CE\u63A7\uFF0Cfallback \u5230 Whisper");
    return null;
  }
  const finalUrl = subtitleUrl.startsWith("//") ? "https:" + subtitleUrl : subtitleUrl;
  const subResult = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(finalUrl)});
    const text = await res.text();
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      return { error: 'HTML_RESPONSE' };
    }
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.body)) return { data: j.body };
      if (Array.isArray(j)) return { data: j };
      return { error: 'UNKNOWN_FORMAT' };
    } catch { return { error: 'PARSE_FAILED' }; }
  })()`);
  if (subResult?.error) {
    throw new TranscribeError(`\u5B57\u5E55 JSON \u83B7\u53D6\u5931\u8D25: ${subResult.error}`);
  }
  const rawItems = subResult?.data ?? [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const segments = rawItems.map((item) => ({
    start: Number(item.from ?? 0),
    end: Number(item.to ?? 0),
    text: String(item.content ?? "")
  }));
  const source = target.lan?.startsWith("ai-") ? "auto_caption" : "manual_caption";
  return { segments, source };
}
function extractBvid(input) {
  const match = input.match(/BV[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || "").join("").slice(0, 32);
}
async function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1e3);
  const allParams = { ...params, wts: String(wts) };
  const sorted = {};
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, "");
  }
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, "%20");
  const wRid = createHash("md5").update(query + mixinKey).digest("hex");
  sorted.w_rid = wRid;
  return sorted;
}
export {
  extractBvid,
  normalizeBilibiliUrl
};
