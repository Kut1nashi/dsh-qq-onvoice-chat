# STT 适配器契约（stt-core.cjs）

`stt-core.cjs` 是**桥接与语音识别引擎之间唯一的接触面**。
桥接按绝对路径 `require` 它（通过 `createRequire`），`qq-bridge-main` 里不装任何模型或依赖。

## 对外接口（桥接依赖的部分）

```js
const stt = require('<你放 stt-core.cjs 的目录>/stt-core.cjs');

stt.available()                    // → boolean：ffmpeg / 模型 / tokens 三个文件是否都在
stt.transcribeBuffer(buf, { keepTemp = false })
//   → { text: string, ms: number }
//   buf 是语音文件的**原始字节**（SILK 的话要保留 0x02 前缀）
stt.transcribeFile(file)           // → 同上，从文件读
stt.warmup()                       // 预热（预加载识别器）
stt.isSilk(buf)                    // → boolean，按内容判断是不是 SILK
stt.SAMPLE_RATE                    // 16000
stt.ROOT                           // 适配器所在目录
```

**失败语义**：识别不出来时 `transcribeBuffer` 返回的 `text` 可能为空字符串——
调用方（`resolveRecordText`）把空文本当作"拿不到转写"，继续降级到 QQ 侧 ASR。
真正的错误（依赖缺失、ffmpeg 失败）会 throw，由调用方 catch 后降级。

## 目录约定

```
<engine>/
├─ stt-core.cjs                  ← 本目录这份文件
├─ model/
│  ├─ model.int8.onnx            ← SenseVoice int8 模型（本机那份 239 MB）
│  └─ tokens.txt                 ← 词表（本机那份 316 KB）
└─ node_modules/                 ← 依赖装在这里，路径写死在适配器里
   ├─ sherpa-onnx-node/
   ├─ silk-wasm/
   └─ @ffmpeg-installer/win32-x64/ffmpeg.exe
```

适配器里的路径**全部相对自己所在目录**（`ROOT = __dirname`），
所以这个引擎目录可以放在任意位置、随便改名，不用改代码。

## 你要做的事

```bat
mkdir voice-stt && cd voice-stt
npm init -y
npm i sherpa-onnx-node@^1.13.8 silk-wasm@^3.7.1 @ffmpeg-installer/win32-x64@^4.1.0
mkdir model
:: 下载 SenseVoice int8 模型，把 model.int8.onnx 和 tokens.txt 放进 model/
copy <本目录>\stt-core.cjs .
```

模型下载见 [../../../docs/ENV-SETUP.md](../../../docs/ENV-SETUP.md) 第二节。
**文件名必须保持 `model.int8.onnx` 和 `tokens.txt`**——适配器里的常量写死了这两个名字
（在文件顶部的 `MODEL` / `TOKENS`）。想用别的模型就改那两行。

## 关于模型版本

本机那份模型**没法从文件本身确认是哪个发布版**（模型目录里没有来源说明），
所以文档只能写"在 sherpa-onnx 的 SenseVoice 预训练模型页挑 int8 那一项"。
只要你的 `model.int8.onnx` + `tokens.txt` 配套来自同一个发布版，就能用。
不配套的典型症状是识别结果全是乱码或空字符串。

## 识别参数

`recognizer()` 里构造 `OfflineRecognizer` 的配置：

```js
modelConfig: {
  senseVoice: { model: MODEL, language: 'zh', useInverseTextNormalization: 1 },
}
```

- `language` 写死 `'zh'`。这个模型本身支持中/英/日/韩/粤，
  想让它自动判别或指定别的语言，改这个字段。
- `useInverseTextNormalization: 1` 会把"二零二六年"这类归一化成"2026年"，
  聊天场景建议保持开启。

## 自检

```bat
cd <engine>
node -e "const s=require('./stt-core.cjs'); console.log('available =', s.available(), '| ROOT =', s.ROOT)"
:: available 必须是 true

node -e "const s=require('./stt-core.cjs'); s.transcribeFile('<一个真实语音文件>').then(r=>console.log(r))"
:: 期望 { text: '识别出来的话', ms: N }
```

| 现象 | 原因 |
|---|---|
| `available = false` | `node_modules` 没装全，或 `model/` 里文件名不对 |
| 抛 `silk decoding failure` | 输入的 SILK 缓冲区被剥掉了开头的 `0x02` |
| `text` 为 `''` | 音频是静音/纯音乐/太短，或模型与 tokens 不配套 |
| ffmpeg 相关报错 | `@ffmpeg-installer/win32-x64` 没装，或平台不是 Windows（换平台要改 `FFMPEG` 常量） |

> `try-stt.mjs` 是端到端自测：`QQ_BRIDGE_CONFIG=<配置> node try-stt.mjs <messageId>`，
> 或 `node try-stt.mjs "" <本地音频文件>` 直接跑本地文件。
