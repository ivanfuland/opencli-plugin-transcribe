# CLAUDE.md

## Project Overview

opencli-plugin-transcribe: YouTube / Bilibili 视频转录插件，优先使用平台字幕，无字幕时 Whisper large-v3 (GPU) 兜底。

## Build & Test

```bash
# 命令入口（youtube-transcribe、bilibili-transcribe）：打包，内部模块会被内联进来
npx esbuild <entry>.ts --bundle --platform=node --format=esm --packages=external --outfile=<entry>.js --allow-overwrite

# 内部模块（_ 开头）与 vitest.config：只转译，保留 import，不要加 --bundle
npx esbuild <module>.ts --platform=node --format=esm --outfile=<module>.js --allow-overwrite

# 改了任何内部模块，两个命令入口都要重新打包，否则运行时仍是入口里内联的旧代码

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
- 内部模块以 `_` 前缀命名：`_download.ts`、`_whisper.ts`、`_config.ts`、`_format.ts`、`_lang-map.ts`、`_temp.ts`、`_errors.ts`、`_deps.ts`

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

- 仅考虑 GPU 模式（PyTorch + CUDA）
- CPU 模式已知有问题，不修复
- 模型默认 `large-v3`（4090 上使用）；`TRANSCRIBE_WHISPER_MODEL` 环境变量可改用更小的模型，给显存放不下 large-v3 的机器（如 8GB 的 RTX 4060 Laptop）用。解析逻辑在 `_whisper.ts` 的 `resolveWhisperModel()`，有单测
- 三个后端：默认 openai-whisper 命令行；`TRANSCRIBE_WHISPER_BACKEND=faster-whisper` 时运行根目录的 `_faster_whisper.py`；`remote` 时流式上传 WAV 到 `TRANSCRIBE_REMOTE_URL` 并轮询结果，不检查本地模型也不回落本地。命令由纯函数 `buildWhisperCommand()` 拼出，单测覆盖两个本地后端；远端走本地假 HTTP 服务测试
- 配置有两层：用户级 `~/.config/opencli/transcribe.json`（键到环境变量的映射在 `_config.ts`），以及覆盖它的环境变量。**优先级：非空环境变量 > 配置文件 > 内置默认**，空串按未设处理。加这层是因为环境变量在进程启动那一刻就定死了，「同一条命令在不同调用方看到的后端不同」会让 `transcribe` 对调用方不透明（2026-09-27 实测翻车两次：旧窗格起的会话、非交互 ssh）。所有解析函数的默认参数走 `effectiveEnv()`，**不要改回 `process.env`**
- opencli 1.8.7 只读取命令 `args` 中的 `timeout` 参数，顶层 `timeoutSeconds` 不生效。两条转写命令都声明默认 25200 秒；远端后端必须在自己的截止时间中止请求，不能只靠 opencli 的 Promise race
- `_faster_whisper.py` 启动时用 ctypes 预加载 `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheel 里的库：CTranslate2 按 soname dlopen 这些库，而 site-packages 不在加载路径上，进程内又改不了 `LD_LIBRARY_PATH`。去掉预加载会报 `libcublas.so.12 is not found`

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
