# opencli-plugin-transcribe

YouTube / Bilibili 视频转录插件。优先使用平台原生字幕，无字幕时自动 fallback 到本地 Whisper `large-v3` 模型转录。

## 前置依赖

安装插件前，请确保以下工具已安装：

| 工具 | 用途 | 安装命令 |
|------|------|----------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 下载音频（Whisper fallback 时使用） | `pip install yt-dlp` 或 `brew install yt-dlp` |
| [openai-whisper](https://github.com/openai/whisper) | 本地 ASR 转录 | `pip install openai-whisper` |
| [ffmpeg](https://ffmpeg.org) | 音频格式转换（yt-dlp 依赖） | `brew install ffmpeg` 或 `apt install ffmpeg` |

**硬件要求（Whisper large-v3）：** 约 10GB VRAM（GPU）或 RAM（CPU）。首次运行会自动下载模型（约 3GB）。

## 安装

```bash
# 从本地目录安装（开发模式，修改立即生效）
opencli plugin install file:///path/to/opencli-plugin-transcribe

# 验证命令已注册
opencli list | grep transcribe
```

## 命令

### `youtube transcribe <url>`

转录 YouTube 视频。优先使用平台字幕，无字幕时 fallback 到 Whisper。

```bash
# 有字幕的视频（直接返回字幕，不调用 Whisper）
opencli youtube transcribe "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 指定语言
opencli youtube transcribe "https://youtu.be/xxxx" --lang zh-Hans

# 原始模式（每段带精确时间戳）
opencli youtube transcribe "https://youtu.be/xxxx" --mode raw

# 强制使用 Whisper（跳过字幕）
opencli youtube transcribe "https://youtu.be/xxxx" --force-asr

# 保留临时音频文件
opencli youtube transcribe "https://youtu.be/xxxx" --force-asr --keep-audio
```

### `bilibili transcribe <url|bvid>`

转录 Bilibili 视频。支持完整 URL 和 BVID 两种输入格式。

```bash
# 使用 BVID
opencli bilibili transcribe BV1xx411c7mD

# 使用完整 URL
opencli bilibili transcribe "https://www.bilibili.com/video/BV1xx411c7mD"

# grouped 模式（默认，合并成段落）
opencli bilibili transcribe BV1xx411c7mD --mode grouped

# raw 模式（每条字幕一行）
opencli bilibili transcribe BV1xx411c7mD --mode raw

# 指定语言
opencli bilibili transcribe BV1xx411c7mD --lang zh-CN

# 强制 Whisper ASR（忽略字幕）
opencli bilibili transcribe BV1xx411c7mD --force-asr --mode raw
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--mode grouped\|raw` | `grouped`: 合并为可读段落；`raw`: 每段独立一行带时间戳 | `grouped` |
| `--lang <code>` | 优先选择的语言轨，不可用时 fallback 到第一轨并输出警告 | 自动选择 |
| `--force-asr` | 跳过字幕，直接使用 Whisper 转录 | `false` |
| `--keep-audio` | 保留临时 WAV 音频文件，并输出文件路径 | `false` |

## 输出字段

**raw 模式：**
```json
{ "index": 1, "start": "0.00s", "end": "3.50s", "text": "...", "source": "manual_caption" }
```

**grouped 模式：**
```json
{ "timestamp": "0:00", "text": "...", "source": "auto_caption" }
```

`source` 字段取值：
- `manual_caption` — 平台人工字幕
- `auto_caption` — 平台自动生成字幕（YouTube ASR / Bilibili AI 字幕）
- `whisper_large_v3` — 本地 Whisper 转录

## 已知限制

- `--force-asr` 仍会初始化浏览器会话（命令注册为 `Strategy.COOKIE`），但不使用 page 对象
- Whisper `large-v3` 需要约 10GB VRAM/RAM，长视频（>1h）单次转录可超过 30 分钟
- 仅支持 YouTube 和 Bilibili，不支持其他平台
- Whisper 模型固定为 `large-v3`，不支持切换
- 不支持远程 ASR API，仅本地推理
- InnerTube / WBI API 可能随平台更新而失效，届时请更新插件

## 开发

```bash
# 运行测试
npm test

# 安装到本地调试
opencli plugin install file://$(pwd)
```
