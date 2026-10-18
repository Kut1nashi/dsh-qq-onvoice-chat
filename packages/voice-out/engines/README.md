# TTS 适配器契约（tts-core.cjs）

`tts-core.cjs` 是**桥接与 GPT-SoVITS 之间唯一的接触面**。
桥接只按绝对路径 `require` 它，仓库里不装任何 Python/模型/二进制。
换音色、换整合包版本、换引擎，都只动这个文件和 `ref/` 目录，bridge 代码不用改。

## 对外接口（桥接依赖的部分）

```js
const tts = require('<你放 tts-core.cjs 的目录>/tts-core.cjs');

tts.available()          // → boolean：默认运行依赖、参考音频及非空原文是否齐备
tts.needsReference()     // → boolean：运行依赖齐备，但缺参考音频或非空原文
tts.synthesize(text, opts)
//   opts: { refAudio?, promptText?, promptLang?, textLang?, splitMethod?,
//           timeoutMs?, startTimeoutMs?, queueTimeoutMs?, maxBytes?, minAudioSeconds?, outDir?, log? }
//   → { path: string, bytes: number, seconds: number, ms: number, timings: {...} }
tts.ensureServer({ log, waitMs: 300000 })  // 复用已响应端口或启动服务；并发共用一次启动
tts.warmup({ log })        // 仅探活
tts.warmup({ text: '这是一段用于预热语音合成的测试文本。', promptLang: 'ja', log })
// → boolean：实际推理、校验并删除预热文件；失败false并记录原因
tts.probe(timeoutMs)       // 探测 HTTP 存活；不保证合成请求成功
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
│  └─ sally_ref.txt    ← 必填，上面那段音频的逐字原文
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

2. **参考音频和原文**。同时放置 `ref/sally_ref.wav` 与非空的 `ref/sally_ref.txt`。
   `available()` 检查这套默认参考材料，缺任一项会返回 `false`，桥接表现为 `tts-unavailable`。
   直接调用 `synthesize()` 时可用 `refAudio` / `promptText` 覆盖默认材料；原文为空会在排队、
   网络请求或启动进程之前报中文错误。此适配器面向需要原文的V3/v4，不再发送空原文做无文本参考推理。

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
| `prompt_text` | 必填的参考音频逐字原文（`promptText` 或 `ref/sally_ref.txt`），会压缩空白 |
| `prompt_lang` | 默认 `zh` |
| `text_split_method` | 默认 `cut5` |
| `batch_size` / `media_type` / `streaming_mode` | `1` / `wav` / `false` |

启动参数（适配器自己拼的）：`-a <host> -p <port> -c <tts_infer.yaml>`。
服务启动预算默认300秒；v5手动启动到HTTP响应33.5/43.8秒、首条推理45.7秒。
合并实测已验证在线推理预热15.76秒且清理产物；这些仍不能替代适配器spawn/冷态预热的实机验证。
HTTP响应不代表模型已完成惰性加载。
`timeoutMs` 默认120秒；自动回复默认最多80字符，超出时发文本，不截断回复。
实测107字符耗时51.3–66.1秒；200字符可能超时是外推风险，尚未实测。

### 排队、超时与响应校验

同一模块实例内只执行一个合成请求，最多再等待 8 条。队列满或等待超时会抛错，
自动回复立即走文本降级；不同进程的队列互相独立。

| 选项 | 默认值 | 范围 |
|---|---|---|
| `queueTimeoutMs` | 90000（引擎、桥接、测速一致） | 等待合成槽位 |
| `startTimeoutMs` | 300000 | 探活及本地服务启动 |
| `timeoutMs` | 120000 | HTTP 合成，包含响应体读取 |
| `maxBytes` | 20971520 | 音频响应体上限，自动回复沿用 `voice.maxBytes` |
| `minAudioSeconds` | 1 | 较长文本产物的秒数下限，非负有限数；0关闭启发式 |

超时和字节限制为正整数，时长下限为非负有限数。各阶段独立计时，总等待时间可能为三个超时之和。
DS实机反馈中，15秒排队预算下三请求仅1条成功，60秒时3条成功；v4复验默认90秒预算时
三短句3/3成功，总19.12秒。不保证任何长度和并发下都能完成。请按本机 `slotMs` / `queueMs` 的P95、
可接受等待和文本降级率调整。已有配置中的15秒/200字符不会自动迁移，请同步更新。
响应按流读取并限制大小，检查WAV的fmt/data样本帧与时长后才保存；非音频、空数据、截断、
HTTP错误均不产出成功结果。未压缩PCM/浮点格式支持范围与部署细节见 [运维说明](../../../docs/TTS-OPERATIONS.md)。
至少10个中日韩文字/数字或10个单词时应用默认1秒下限，拒绝明显碎片；
短回复或单个英文词不应用此下限。规则可配置且不是漏字、静音或音质判定。
服务探活保留无参数 `GET /tts`，任一HTTP响应（含404/500）都表示端口已被占用；
探活响应体会释放。实际 `api_v2` 可对裸GET返回500、对合法POST返回200，不能因此重复启动。
`probe()`及不传text的 `warmup()`成功只代表HTTP存活，不验证模型、路由或推理能力；
若该端口运行了其它HTTP服务，也不会抢占端口，合法POST的错误会原样进入合成异常。

启动异常、进程提前退出、启动超时都会抛错并清理本次启动的子进程。
已启动的本地进程若探活失败，会报错并保留进程句柄，避免重复启动、端口冲突；
可检查服务日志或调用 `stop()` 后重试。
`stop()` 会取消正在等待的启动、拒绝排队请求，并终止本模块启动的进程；
不会终止外部启动的服务。已发往外部服务的推理仍受 `timeoutMs` 控制。
外部NSSM/systemd管理Python时，在加载适配器前设置Node进程的 `VOICE_TTS_AUTO_START=false`，
端口未响应时将报错而不spawn，避免两个管理者争抢端口；默认仍按请求启动，不是持续守护。
推理预热需显式传text，在放行正常请求前执行，避免初次惰性加载挤占排队预算。
新防护及预热没有自动重启外部服务，降级态根因仍待模型侧诊断。
be8ffa3已获正常真实合成、在线预热及替身协议防护验收；实际bridge/QQ与主观音质仍未完成。

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
| `available = false` 且 `needsReference = true` | 缺 `ref/sally_ref.wav` 或 `ref/sally_ref.txt` 为空/不可读 |
| `available = false` 且 `needsReference = false` | `GSV_DIR` 路径不对（`python.exe`/`api_v2.py`/`tts_infer.yaml` 至少缺一个） |
| `缺少参考原文` | 填写 `ref/sally_ref.txt` 或传非空 `promptText`，必须与参考音频对应 |
| 合成 `POST` 报 `TTS HTTP 400/500` | 查看随异常透传的服务端原因；裸GET探活的500本身不是合成失败 |
| 一直卡住到超时 | 首次加载慢；先手动跑一次整合包的 `api_v2.py` 确认能起来 |
| `TTS 合成队列已满` / `排队超时` | 请求积压，自动回复会降级为文本 |
| `TTS 返回无效 WAV 音频` | 服务返回空内容、JSON 或其它非 WAV 数据 |
| `TTS 音频超过上限` | 返回音频超过 `maxBytes`，检查文本长度与服务输出 |
| `TTS 音频异常过短` | 较长文本生成明显碎片，退回文本并检查引擎加载状态；需要时校准minAudioSeconds |
| `按需启动已关闭` | 外部守护模式下端口未响应，检查NSSM/systemd状态；不要额外再拉一个模型 |
