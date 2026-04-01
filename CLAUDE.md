# CLAUDE.md

## Project Overview

opencli-plugin-transcribe: YouTube / Bilibili 视频转录插件，优先使用平台字幕，无字幕时 Whisper large-v3 (GPU) 兜底。

## Build & Test

```bash
# 编译单个 .ts 文件（每次修改 .ts 后都要重新编译对应的 .js）
npx esbuild <file>.ts --bundle --platform=node --format=esm --packages=external --outfile=<file>.js --allow-overwrite

# 运行测试
npm test

# 本地安装调试
opencli plugin install file://$(pwd)

# GitHub 安装
opencli plugin install github:ivanfuland/opencli-plugin-transcribe
```

## Architecture

- 源码 `.ts`，编译产物 `.js` 一并提交（opencli 运行时直接加载 `.js`）
- opencli 只扫描插件根目录的 `.js` 文件作为命令，不能移入 `src/` 子目录
- 命令文件：`youtube-transcribe.ts`、`bilibili-transcribe.ts`
- 内部模块以 `_` 前缀命名：`_download.ts`、`_whisper.ts`、`_format.ts`、`_lang-map.ts`、`_temp.ts`、`_errors.ts`、`_deps.ts`

## YouTube 字幕获取流程

1. `yt-dlp --dump-json` 获取可用字幕列表（`subtitles` + `automatic_captions`）
2. `pickSubtitleLang()` 按偏好选择：用户指定语言 > 手动字幕 > 自动字幕
3. `yt-dlp --write-sub --sub-format json3` 下载选中的字幕
4. 无字幕时走 Whisper 兜底

**注意**: 不要用 YouTube timedtext API 的 baseUrl 直接 fetch，会返回空响应。

## Bilibili 字幕获取流程

1. 浏览器 `page.goto()` 打开视频页
2. 从 `__INITIAL_STATE__` 提取 CID
3. WBI 签名调用 `/x/player/wbi/v2` 获取字幕列表
4. 浏览器 fetch 字幕 JSON
5. 无字幕时走 Whisper 兜底

## yt-dlp 环境要求

- `DESKTOP_SESSION=gnome`：Chrome v11 cookie 解密需要
- `--cookies-from-browser chrome`：复用浏览器登录态
- `--remote-components ejs:github`：解决 YouTube n-challenge

## Whisper 环境

- 仅考虑 GPU 模式（4090 + PyTorch + CUDA）
- CPU 模式已知有问题，不修复

## Known Pitfalls

### YouTube timedtext baseUrl 返回空响应
`ytInitialPlayerResponse` 中的 `captionTracks[].baseUrl` 看似有效（HTTP 200），但实际返回 content-length: 0 的空 body。无论用 browser fetch、XHR、Node https 还是 curl 都一样。**必须用 yt-dlp 子进程下载字幕**，它走的是不同的 API 路径。

### YouTube 字幕语言代码不统一
YouTube 手动字幕的语言代码可能是 `zh`、`zh-Hans`、`zh-Hant` 等变体。硬编码 `--sub-lang zh` 会漏掉 `zh-Hans` 的字幕。**正确做法是先 `--dump-json` 获取可用字幕列表，再按偏好匹配下载**，而不是盲猜语言代码。

### SegmentsWithMeta 反模式
不要在 Array 实例上 monkey-patch 自定义属性（如 `segments._isAuto = true`）。Array 的 `map/filter/slice` 等方法返回新数组，自定义属性会丢失。用 `{ segments, isAuto }` 对象包装。

### 空 catch 吞错误
`catch { }` 或 `catch { // not available }` 会让所有错误静默消失，导致调试困难。catch 块必须 `console.error` 记录错误信息。

### opencli 插件不能放 src/ 子目录
`scanPluginCommands()` 只扫描插件根目录的 `.js`/`.ts` 文件，不递归子目录。源码不能移入 `src/`。

### GitHub 安装 vs 本地安装
`opencli plugin install github:...` 从远程拉代码。本地改了代码但没 push，GitHub 安装的插件不会更新。开发调试时用 `file://` 本地安装，确认无误后再 push + GitHub 安装。

### yt-dlp 缺少 DESKTOP_SESSION 环境变量
Linux 上 Chrome v11 的 cookie 使用 GNOME Keyring 加密。yt-dlp 的 `--cookies-from-browser chrome` 需要 `DESKTOP_SESSION=gnome` 环境变量才能正确解密，否则报错。

## Coding Conventions

- 修改 `.ts` 后必须用 esbuild 重新编译对应 `.js` 再提交
- `SubtitleResult { segments, isAuto }` 模式传递字幕数据，不要在 Array 上挂自定义属性
- catch 块必须记录错误日志，不允许空 catch
- 默认输出模式为 `raw`（对 LLM 更友好）
