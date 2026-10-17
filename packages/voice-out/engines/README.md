# TTS 适配器契约（tts-core.cjs）

`tts-core.cjs` 是**桥接与 GPT-SoVITS 之间唯一的接触面**。
桥接只按绝对路径 `require` 它，仓库里不装任何 Python/模型/二进制。
换音色、换整合包版本、换引擎，都只动这个文件和 `ref/` 目录，bridge 代码不用改。

## 对外接口（桥接依赖的部分）

```js
const tts = require('<你放 tts-core.cjs 的目录>/tts-core.cjs');

tts.available()          // → boolean：整合包/运行时/配置/参考音频是否齐备
tts.needsReference()     // → boolean：只差参考音频时为 true，用来给人一句明确提示
tts.synthesize(text, opts)
//   opts: { refAudio?, promptText?, promptLang?, textLang?, splitMethod?,
//           timeoutMs?, startTimeoutMs?, queueTimeoutMs?, maxBytes?, outDir?, log? }
//   → { path: string, bytes: number, ms: number, timings: {...} }
tts.ensureServer({ log, waitMs: 180000 })  // 拉起 FastAPI 服务（并发调用共用一次启动）
tts.warmup({ log })        // 预热
tts.probe(timeoutMs)       // 探测服务是否在跑
tts.referenceText()        // 读 ref/sally_ref.txt
tts.cutReference(srcFile, startSec, durSec, opts)  // 从视频里切参考音频
tts.separateVocals(srcFile, opts)                  // 去背景声
tts.stop()                 // 关掉本模块拉起的服务（不动别人起的）
```

**`synthesize` 的失败语义**：任何一步失败都 **throw**，不返回假结果、不返回空音频。
调用方（`maybeReplyAsVoiceV2`）负责 catch 后退回文本发送。
这是有意的——别在适配器里吞异常，否则 AI 会以为语音发出去了。

**产物所有权**：每次成功合成都返回独立 WAV 文件，调用方在使用完后负责删除。
自动回复桥接在发送结束或失败时都会清理文件；CLI 自测会保留产物供试听。
`ms` 是本次 HTTP 合成和写盘耗时，不包含排队及服务启动时间。
`timings` 使用单调时钟分别记录 `queueMs`、`serverMs`（探活/启动）、`requestMs`
（HTTP与响应读取）、`saveMs`、`slotMs`（占用合成槽）和 `totalMs`。
`requestMs` 包含网络开销，不能直接标成模型推理时间。

## 目录与路径约定

```
<engine>/
├─ tts-core.cjs        ← 就是本目录这份文件
├─ ref/
│  ├─ sally_ref.wav    ← 必填，3~10 秒干净单人声（默认参考音频）
│  └─ sally_ref.txt    ← 强烈建议，上面那段音频的逐字原文
└─ out/                ← 合成产物（自动创建）

<GSV_DIR>/              ← GPT-SoVITS 整合包，路径由下面两个方式之一给出
├─ runtime/python.exe
├─ api_v2.py
├─ ffmpeg.exe
└─ GPT_SoVITS/configs/tts_infer.yaml
```

## 你必须要改的地方

1. **整合包路径**。按「环境变量 → `gsv-dir.txt` → `./GPT-SoVITS`」解析：

   ```js
   // 配置优先级：VOICE_TTS_GSV_DIR → 本目录 gsv-dir.txt 首行 → ./GPT-SoVITS
   ```

   推荐用环境变量（不改代码）：

   ```bat
   set VOICE_TTS_GSV_DIR=E:\ai\GPT-SoVITS-v4
   ```

   也可以把整合包直接放进本目录并命名为 `GPT-SoVITS`，或在本目录写 `gsv-dir.txt`
   （首行写绝对路径）。适配器里**没有**任何原机器路径。

   服务地址可用 `VOICE_TTS_HOST`（默认 `127.0.0.1`）、`VOICE_TTS_PORT`（默认 `9880`）覆盖。
   Linux/macOS 或自建 Python 环境可设置 `VOICE_TTS_PYTHON` 和 `VOICE_TTS_FFMPEG`
   为可执行文件的完整路径，无需修改源码；默认仍使用整合包里的 `runtime/python.exe` / `ffmpeg.exe`。

2. **参考音频**。只改路径不够，还要真的放一个 `ref/sally_ref.wav`。
   `available()` 的判据里包含它，缺了会返回 `false`，桥接那边就表现为 `tts-unavailable`。

3. **音色来源的合法性**。参考音频决定克隆出来的声音像谁。
   用真人/演员的声音做音色克隆可能涉及他人声音权与著作权，**自己去确认能不能用**——
   这个包只提供技术链路，不对你选的音色负责。

## 服务形态

GPT-SoVITS 自带的 `api_v2.py` 是个 FastAPI，合成请求使用 `POST /tts` + JSON，
避免长文本超出 URL 限制，或让回复正文进入 URL 日志。参数：

| 参数 | 值 |
|---|---|
| `text` | 要合成的文本 |
| `text_lang` | 默认 `zh` |
| `ref_audio_path` | 参考音频绝对路径 |
| `prompt_text` | 参考音频原文（`ref/sally_ref.txt`，建议给） |
| `prompt_lang` | 默认 `zh` |
| `text_split_method` | 默认 `cut5` |
| `batch_size` / `media_type` / `streaming_mode` | `1` / `wav` / `false` |

启动参数（适配器自己拼的）：`-a <host> -p <port> -c <tts_infer.yaml>`。
首次合成要先加载模型，会等几十秒；`timeoutMs` 默认 120 s（桥接配置里也是 120000）。

### 排队、超时与响应校验

同一模块实例内只执行一个合成请求，最多再等待 8 条。队列满或等待超时会抛错，
自动回复立即走文本降级；不同进程的队列互相独立。

| 选项 | 默认值 | 范围 |
|---|---|---|
| `queueTimeoutMs` | 引擎默认同 `timeoutMs`；自动回复默认 15000 | 等待合成槽位 |
| `startTimeoutMs` | 180000 | 探活及本地服务启动 |
| `timeoutMs` | 120000 | HTTP 合成，包含响应体读取 |
| `maxBytes` | 20971520 | 音频响应体上限，自动回复沿用 `voice.maxBytes` |

这些限制均为正整数。各阶段独立计时，总等待时间可能为三个超时之和。
15秒排队预算可能不适合慢CPU或多请求积压。请测量本机 `slotMs` 和 `queueMs` 的P95，
再对30000/45000等候选预算与文本降级率做比较；本轮没有真实模型数据，因此没有自动调高默认值。
响应按流读取并限制大小，检查 RIFF/WAVE 文件头后才保存；非音频、空内容、
HTTP 错误均不产出成功结果。WAV 文件头检查不能代替实际解码或试听。
服务探活保留无参数 `GET /tts`，接受成功响应或参数校验错误 400/422；
404、5xx 和连接失败均不算就绪，探活响应体会释放。

启动异常、进程提前退出、启动超时都会抛错并清理本次启动的子进程。
已启动的本地进程若探活失败，会报错并保留进程句柄，避免重复启动、端口冲突；
可检查服务日志或调用 `stop()` 后重试。
`stop()` 会取消正在等待的启动、拒绝排队请求，并终止本模块启动的进程；
不会终止外部启动的服务。已发往外部服务的推理仍受 `timeoutMs` 控制。

## 自检

```bat
cd <engine>
node tts-core.cjs "这是一条语音回复测试。"
:: 期望：available = true / needsReference = false / OK {"path":"...out/tts-....wav","bytes":N,"ms":M}
:: 然后**亲耳听一遍**那个 wav —— 不对就回去修参考音频，别去调代码
```

常见失败：

| 打印 | 原因 |
|---|---|
| `available = false` 且 `needsReference = true` | 没放 `ref/sally_ref.wav` |
| `available = false` 且 `needsReference = false` | `GSV_DIR` 路径不对（`python.exe`/`api_v2.py`/`tts_infer.yaml` 至少缺一个） |
| `TTS HTTP 500` | 整合包模型没下全，或显存不够 |
| 一直卡住到超时 | 首次加载慢；先手动跑一次整合包的 `api_v2.py` 确认能起来 |
| `TTS 合成队列已满` / `排队超时` | 请求积压，自动回复会降级为文本 |
| `TTS 返回无效 WAV 音频` | 服务返回空内容、JSON 或其它非 WAV 数据 |
| `TTS 音频超过上限` | 返回音频超过 `maxBytes`，检查文本长度与服务输出 |
