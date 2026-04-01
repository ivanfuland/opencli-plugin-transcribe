# opencli-plugin-transcribe

YouTube / Bilibili 视频转录插件。优先使用平台原生字幕，无字幕时自动 fallback 到本地 Whisper `large-v3` 模型转录。

## 前置依赖

安装插件前，请确保以下工具已安装：

| 工具 | 用途 | 安装命令 |
|------|------|----------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 下载字幕和音频 | `pip install yt-dlp` 或 `brew install yt-dlp` |
| [openai-whisper](https://github.com/openai/whisper) | 本地 ASR 转录（GPU fallback） | `pip install openai-whisper` |
| [ffmpeg](https://ffmpeg.org) | 音频格式转换 | `brew install ffmpeg` 或 `apt install ffmpeg` |

**硬件要求（Whisper large-v3）：** 约 10GB VRAM（GPU）或 RAM（CPU）。首次运行会自动下载模型（约 3GB）。

## 安装

```bash
# 从本地目录安装（开发模式，修改立即生效）
opencli plugin install file:///path/to/opencli-plugin-transcribe

# 验证命令已注册
opencli list | grep transcribe
```

## 工作原理

### 字幕获取策略

插件按以下优先级获取字幕：

1. **手动字幕** — 通过 yt-dlp `--write-sub --sub-format json3` 下载平台上传的人工字幕
2. **自动字幕** — 通过 yt-dlp `--write-auto-sub --sub-format json3` 下载平台自动生成的字幕（YouTube ASR / Bilibili AI）
3. **Whisper ASR** — 本地 Whisper `large-v3` 模型对音频进行语音识别（GPU 优先）

使用 `--force-asr` 可跳过步骤 1-2，直接使用 Whisper 转录。

### YouTube 特有行为

- 浏览器导航到视频页面，从 `ytInitialPlayerResponse` 提取音频流 URL（itag 140, m4a 128kbps）
- 字幕下载通过 yt-dlp 完成（YouTube timedtext API 的 baseUrl 已无法直接 fetch）
- Whisper fallback 时优先使用提取的音频流 URL（通过 ffmpeg 直接下载，跳过 yt-dlp）
- yt-dlp 使用 `--cookies-from-browser chrome` 获取登录态，环境变量 `DESKTOP_SESSION` 默认设为 `gnome`（修复 Linux 下 Chrome v11 cookie 解密问题）
- yt-dlp 使用 `--remote-components ejs:github` 解决 YouTube n-parameter challenge

### Bilibili 特有行为

- 浏览器导航到视频页面，从 `__INITIAL_STATE__` 提取 CID 和 BVID
- 通过浏览器 fetch 获取 WBI 签名密钥（`/x/web-interface/nav`），Node 侧完成 MD5 签名
- 使用签名参数请求 `/x/player/wbi/v2` 获取字幕列表，再 fetch 字幕 JSON
- Bilibili AI 字幕（`lan` 以 `ai-` 开头）标记为 `auto_caption`

### Whisper 转录

- 模型固定为 `large-v3`，不支持切换
- 设备选择：优先 CUDA GPU，CUDA 失败时 fallback 到 CPU
- 每 30 秒输出心跳日志（`[whisper] transcribing... Ns elapsed`），防止调用方误判进程挂起
- 超时：Whisper 子进程 30 分钟，整体命令超时 7 小时（25200 秒）

### 临时文件

- 临时目录：`/tmp/opencli-transcribe-XXXXXX`（系统临时目录下随机后缀）
- 正常完成后自动删除
- 使用 `--keep-audio` 时保留并打印路径
- 进程被 SIGINT/SIGTERM 中断时通过注册的 cleanup hook 自动清理

## 命令

### `youtube transcribe <url>`

转录 YouTube 视频。

```bash
# 有字幕的视频（直接返回字幕，不调用 Whisper）
opencli youtube transcribe "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 指定语言
opencli youtube transcribe "https://youtu.be/xxxx" --lang zh-Hans

# grouped 模式（合并段落）
opencli youtube transcribe "https://youtu.be/xxxx" --mode grouped

# 强制使用 Whisper（跳过字幕）
opencli youtube transcribe "https://youtu.be/xxxx" --force-asr

# 保留临时音频文件
opencli youtube transcribe "https://youtu.be/xxxx" --force-asr --keep-audio
```

支持的 URL 格式：
- `https://www.youtube.com/watch?v=ID`
- `https://youtu.be/ID`
- `https://www.youtube.com/shorts/ID`
- `https://www.youtube.com/embed/ID`
- `https://www.youtube.com/live/ID`
- 纯视频 ID（如 `dQw4w9WgXcQ`）

### `bilibili transcribe <url|bvid>`

转录 Bilibili 视频。

```bash
# 使用 BVID
opencli bilibili transcribe BV1xx411c7mD

# 使用完整 URL
opencli bilibili transcribe "https://www.bilibili.com/video/BV1xx411c7mD"

# grouped 模式
opencli bilibili transcribe BV1xx411c7mD --mode grouped

# 指定语言
opencli bilibili transcribe BV1xx411c7mD --lang zh-CN

# 强制 Whisper ASR
opencli bilibili transcribe BV1xx411c7mD --force-asr
```

## 参数说明

| 参数 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | 是 | string（位置参数） | — | 视频 URL 或 ID |
| `--lang` | 否 | string | 自动选择 | 字幕语言代码，不可用时 fallback 到第一轨并输出警告 |
| `--mode` | 否 | `raw` / `grouped` | `raw` | `raw`：逐句输出，每句带精确起止时间戳；`grouped`：按约 30 秒合并成段落 |
| `--force-asr` | 否 | boolean | `false` | 跳过平台字幕，直接使用 Whisper 转录 |
| `--keep-audio` | 否 | boolean | `false` | 保留临时 WAV 音频文件并输出路径（仅 Whisper fallback 时有效） |

## 输出格式

**raw 模式（默认）：**
```
| Index | Start   | End     | Text           | Source         |
| 1     | 0.00s   | 3.50s   | 大家好...      | manual_caption |
| 2     | 3.50s   | 7.20s   | 今天我们...    | manual_caption |
```

**grouped 模式：**
```
| Timestamp | Text                          | Source         |
| 0:00      | 大家好...今天我们...          | manual_caption |
| 0:32      | 接下来...                     | manual_caption |
```

`source` 字段取值：
- `manual_caption` — 平台人工字幕
- `auto_caption` — 平台自动生成字幕（YouTube ASR / Bilibili AI 字幕）
- `whisper_large_v3` — 本地 Whisper 转录

## 已知限制

- Whisper `large-v3` 需要约 10GB VRAM，长视频（>1h）单次转录可能超过 30 分钟
- 仅支持 YouTube 和 Bilibili 两个平台
- Whisper 模型固定为 `large-v3`，不支持切换
- 不支持远程 ASR API，仅本地推理
- yt-dlp / WBI API 可能随平台更新而失效，届时请更新插件

## 开发

```bash
# 运行测试
npm test

# 安装到本地调试
opencli plugin install file://$(pwd)
```
