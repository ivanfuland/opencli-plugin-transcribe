# opencli-plugin-transcribe

YouTube / Bilibili 视频转录插件。优先使用平台原生字幕，无字幕时按配置使用本地或远端 Whisper 转录。

## 前置依赖

安装插件前，请确保以下工具已安装：

| 工具 | 用途 | 安装命令 |
|------|------|----------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 下载字幕和音频 | `pip install yt-dlp` 或 `brew install yt-dlp` |
| [openai-whisper](https://github.com/openai/whisper) | 默认本地后端需要；远端后端不需要 | `pip install openai-whisper` |
| [ffmpeg](https://ffmpeg.org) | 音频格式转换 | `brew install ffmpeg` 或 `apt install ffmpeg` |

**本地硬件要求（Whisper large-v3）：** 约 10GB VRAM（GPU）或 RAM（CPU）。首次运行会自动下载模型（约 3GB）。远端后端不在本机加载模型；显存不够时可用远端后端或在本地改用小模型。

## 安装

需要 opencli `>=1.5.0`。

```bash
# 从 GitHub 安装
opencli plugin install github:ivanfuland/opencli-plugin-transcribe

# 或从本地目录安装（开发模式，修改立即生效）
opencli plugin install file:///path/to/opencli-plugin-transcribe

# 验证命令已注册
opencli list | grep transcribe
```

## 工作原理

### 字幕获取策略

插件按以下优先级获取字幕：

1. **手动字幕** — 通过 yt-dlp `--write-sub --sub-format json3` 下载平台上传的人工字幕
2. **自动字幕** — 通过 yt-dlp `--write-auto-sub --sub-format json3` 下载平台自动生成的字幕（YouTube ASR / Bilibili AI）
3. **Whisper ASR** — 按后端配置在本机或远端进行语音识别

使用 `--force-asr` 可跳过步骤 1-2，直接使用 Whisper 转录。

使用 `--subs-only` 则只取字幕：凡是会回落到 Whisper 的情况（没有字幕，或字幕获取出错），都改为不下载音频、不跑 Whisper，命令以退出码 1 结束，错误消息以 `TRANSCRIBE_NO_SUBTITLES` 开头，由 opencli 写到 stderr。调用方在 stderr 里匹配这个标记，就能把「该转录了」与参数错误等其他失败区分开，再自行决定在哪里转录。`--subs-only` 下 YouTube 也不再打开视频页去取音频流地址。`--subs-only` 与 `--force-asr` 不能同时使用。

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

- 模型默认 `large-v3`；设置环境变量 `TRANSCRIBE_WHISPER_MODEL` 可换成任意 Whisper 模型名（如 `turbo`、`medium`、`small`），留空或不设时仍为 `large-v3`。显存装不下 large-v3 的机器（例如 8GB 的笔记本显卡）应设成更小的模型，或改用下面的 faster-whisper 后端，因为 CPU 兜底路径已知有问题
- 后端默认是 openai-whisper 命令行。设 `TRANSCRIBE_WHISPER_BACKEND=faster-whisper` 改用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 推理，支持 int8 量化），由插件自带的 `_faster_whisper.py` 执行，输出格式与 openai-whisper 相同
- 设 `TRANSCRIBE_WHISPER_BACKEND=remote` 时，插件把下载的 WAV 流式上传到 `TRANSCRIBE_REMOTE_URL` 的 `/api/whisper/jobs`，每 10 秒查询状态；排队和运行期间每 30 秒输出心跳。服务端需返回 `queued`、`running`、`completed` 或 `failed` 状态以及完成时的 `segments`。连接失败或远端任务失败会直接报错，不自动回落到本地 GPU
- 运行时 stderr 会打印一行 `[whisper] model: <名称>`，faster-whisper 后端会附上后端名和计算精度，便于确认实际配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TRANSCRIBE_WHISPER_MODEL` | `large-v3` | 模型名，两个后端通用 |
| `TRANSCRIBE_WHISPER_BACKEND` | `openai` | `openai`、`faster-whisper` 或 `remote` |
| `TRANSCRIBE_REMOTE_URL` | 无 | 仅 remote：提供听写 job 接口的 HTTP(S) 服务根地址，必填 |
| `TRANSCRIBE_WHISPER_COMPUTE_TYPE` | `int8_float16` | 仅 faster-whisper：CTranslate2 计算精度，如 `float16`、`int8_float16`；回落到 CPU 时自动改用 `int8` |
| `TRANSCRIBE_FASTER_WHISPER_PYTHON` | `python3` | 仅 faster-whisper：能 `import faster_whisper` 的 Python 解释器，通常指向专用 venv |

### 配置文件（推荐）

环境变量在进程启动那一刻就从父进程抄定了。于是同一条命令在终端里、在 agent 的 Bash 里、在 `ssh host '...'` 里看到的后端可能各不相同——「调用 `transcribe`」这件事因此对调用方不透明。放一份用户级配置文件可以消掉这一点：它在运行时读，任何调用方看到的都一样。

```
~/.config/opencli/transcribe.json
{
  "backend": "remote",
  "remoteUrl": "http://transcribe-host:4000",
  "model": "turbo"
}
```

| 键 | 对应的环境变量 |
|---|---|
| `backend` | `TRANSCRIBE_WHISPER_BACKEND` |
| `remoteUrl` | `TRANSCRIBE_REMOTE_URL` |
| `model` | `TRANSCRIBE_WHISPER_MODEL` |
| `fasterWhisperPython` | `TRANSCRIBE_FASTER_WHISPER_PYTHON` |
| `computeType` | `TRANSCRIBE_WHISPER_COMPUTE_TYPE` |

优先级：**非空的环境变量 > 配置文件 > 内置默认**。空串按未设处理——一个空变量不该把机器级设置顶掉。用 `TRANSCRIBE_CONFIG_FILE` 可以指向别的文件（测试靠它把配置关掉）。文件不存在、JSON 坏、值不是字符串，都只会退回内置默认，不会让转写失败。

faster-whisper 后端的 GPU 运行库：CTranslate2 需要 CUDA 12 的 cuBLAS 和 cuDNN 9。可以在同一个 venv 里装 `nvidia-cublas-cu12` 与 `nvidia-cudnn-cu12==9.*`，脚本启动时会自动预加载，不需要设置 `LD_LIBRARY_PATH`：

```bash
uv venv ~/.local/share/faster-whisper/venv
uv pip install -p ~/.local/share/faster-whisper/venv faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
export TRANSCRIBE_WHISPER_BACKEND=faster-whisper
export TRANSCRIBE_FASTER_WHISPER_PYTHON=~/.local/share/faster-whisper/venv/bin/python
export TRANSCRIBE_WHISPER_MODEL=turbo
```

实测（RTX 4060 Laptop 8GB，91 分钟中文播客，对照人工字幕）：

| 配置 | 显存峰值 | 转写耗时 | 字错误率 |
|---|---|---|---|
| openai-whisper small | 2196 MiB | 约 460 秒（含下载） | 8.79% |
| openai-whisper turbo | 5674 MiB | 约 434 秒（含下载） | 6.31% |
| faster-whisper turbo int8_float16 | 1306 MiB | 149 秒 | 6.37% |
| faster-whisper large-v3 int8_float16 | 3034 MiB | 576 秒 | 6.45% |
| faster-whisper large-v3 float16 | 4602 MiB | 647 秒 | 6.37% |

- 设备选择：优先 CUDA GPU，CUDA 失败时 fallback 到 CPU
- 每 30 秒输出心跳日志（`[whisper] transcribing... Ns elapsed`），防止调用方误判进程挂起
- 两条 `transcribe` 命令都声明 `--timeout`，默认 25200 秒（7 小时）；remote 到期会中止客户端上传或轮询。已有远端 job 可能仍在服务端运行
- 本地 Whisper 子进程超时 30 分钟

### 远端后端的网络边界

当前内网部署只对受信任的局域网与尾网开放听写接口，没有应用层鉴权。任何能访问该接口的设备都能提交音频、占用 GPU 队列，并在知道 job ID 时查询结果。不要把服务地址额外公开到公网。

```bash
export TRANSCRIBE_WHISPER_BACKEND=remote
export TRANSCRIBE_REMOTE_URL=http://gpu-host.internal:4000
opencli youtube transcribe 'https://www.youtube.com/watch?v=example' --force-asr
```

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
| `--lang` | 否 | string | 自动选择 | 字幕语言代码。未指定时按以下优先级自动选择：**视频原语言**（yt-dlp `info.language`）→ 硬编码偏好 `zh-Hans / zh-Hant / zh / en / ja / ko` → 首个可用字幕。YouTube 的 `automatic_captions` 包含原语言 ASR + 150+ 翻译版本，传入 `info.language` 可保证默认拿到原语言 ASR 而非翻译版 |
| `--mode` | 否 | `raw` / `grouped` | `raw` | `raw`：逐句输出，每句带精确起止时间戳；`grouped`：按约 30 秒合并成段落 |
| `--force-asr` | 否 | boolean | `false` | 跳过平台字幕，直接使用 Whisper 转录 |
| `--subs-only` | 否 | boolean | `false` | 只取字幕；没有字幕时以 `TRANSCRIBE_NO_SUBTITLES` 失败，不回落到 Whisper。不能与 `--force-asr` 同用 |
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
- `whisper_<模型>` — 本地 Whisper 转录，值随 `TRANSCRIBE_WHISPER_MODEL` 变化：模型名转小写、非字母数字换成 `_`，如默认的 `whisper_large_v3`、`turbo` 对应的 `whisper_turbo`；远端以服务端 job 记录为准

## 已知限制

- 本地 Whisper `large-v3` 需要约 10GB VRAM，长视频（>1h）单次转录可能超过 30 分钟；显存不够时用 `TRANSCRIBE_WHISPER_MODEL` 换小模型或改用远端后端
- 仅支持 YouTube 和 Bilibili 两个平台
- 远端后端需要兼容上述 job 接口；插件不提供服务端，也不取消已经提交的远端 job
- yt-dlp / WBI API 可能随平台更新而失效，届时请更新插件

## 开发

项目结构：源码为 `.ts` 文件，编译产物 `.js` 一并提交（插件运行时直接加载 `.js`）。

```
├── youtube-transcribe.ts   # YouTube 转录命令
├── bilibili-transcribe.ts  # Bilibili 转录命令
├── _download.ts            # yt-dlp 音频下载
├── _whisper.ts             # Whisper 调用（选择后端、拼命令、解析输出）
├── _faster_whisper.py      # faster-whisper 后端的执行脚本
├── _format.ts              # 输出格式化（raw / grouped）
├── _lang-map.ts            # 语言代码映射
├── _temp.ts                # 临时目录管理
├── _errors.ts              # 错误类型
├── _deps.ts                # 依赖检查
├── tests/                  # 单元测试（vitest）
└── opencli-plugin.json     # 插件元信息
```

```bash
# 运行测试
npm test

# 安装到本地调试
opencli plugin install file://$(pwd)
```
