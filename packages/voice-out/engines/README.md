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
//           timeoutMs?, outDir?, log? }
//   → { path: string, bytes: number, ms: number }
tts.ensureServer({ log })  // 拉起 FastAPI 服务（幂等）
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
   const GSV_DIR = String(process.env.VOICE_TTS_GSV_DIR || '').trim()
     || path.join(ROOT, 'GPT-SoVITS');
   ```

   推荐用环境变量（不改代码）：

   ```bat
   set VOICE_TTS_GSV_DIR=E:\ai\GPT-SoVITS-v4
   ```

   也可以把整合包直接放进本目录并命名为 `GPT-SoVITS`，或在本目录写 `gsv-dir.txt`
   （首行写绝对路径）。适配器里**没有**任何原机器路径。

   另有两个可选覆盖：`VOICE_TTS_HOST`（默认 `127.0.0.1`）、`VOICE_TTS_PORT`（默认 `9880`）。

2. **参考音频**。只改路径不够，还要真的放一个 `ref/sally_ref.wav`。
   `available()` 的判据里包含它，缺了会返回 `false`，桥接那边就表现为 `tts-unavailable`。

3. **音色来源的合法性**。参考音频决定克隆出来的声音像谁。
   用真人/演员的声音做音色克隆可能涉及他人声音权与著作权，**自己去确认能不能用**——
   这个包只提供技术链路，不对你选的音色负责。

## 服务形态

GPT-SoVITS 自带的 `api_v2.py` 是个 FastAPI，适配器按官方参数走 `GET /tts`：

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
