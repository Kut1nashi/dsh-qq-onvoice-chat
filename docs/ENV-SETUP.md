# 本地环境要点（不含任何部署包）

这两块语音能力各自依赖一个**跑在本机的引擎**。引擎不在这个包里，也没有把本机那份复制给你——
请按下面的地址自己下载，**装在哪里都行**，装完只需要改配置里的 `module` 路径。

---

## 一、语音输出：GPT-SoVITS（文本 → 你的音色）

### 要什么

| 项 | 说明 |
|---|---|
| GPT-SoVITS 整合包 | 本机用的是 **v4 整合包**（`GPT-SoVITS-v4-20250529.7z`，**7.5 GB**，含 portable Python 运行时和模型） |
| 整合包内路径 | 适配器要能读到 `<整合包>/runtime/python.exe`、`<整合包>/api_v2.py`、`<整合包>/ffmpeg.exe`、`<整合包>/GPT_SoVITS/configs/tts_infer.yaml` |
| 参考音频 | **必填**：3~10 秒、单人、无 BGM/混响的干净人声，放 `<engine>/ref/sally_ref.wav` |
| 参考文本 | 强烈建议：上面那段音频的逐字原文，放 `<engine>/ref/sally_ref.txt`（给了它克隆明显更稳） |
| GPU | 建议 NVIDIA 显卡；CPU 也能跑但很慢 |
| 端口 | 适配器默认拉起到 `127.0.0.1:9880`（`VOICE_TTS_HOST` / `VOICE_TTS_PORT` 可覆盖） |

### 哪里下

- 官方仓库（`api_v2.py` 就在仓库根目录）：<https://github.com/RVC-Boss/GPT-SoVITS>
- Windows 整合包下载说明（**推荐走这条**，省掉手装 torch/CUDA）：<https://github.com/RVC-Boss/GPT-SoVITS/blob/main/docs/cn/README.md>

### 接入步骤

1. 解压整合包到你自己的目录，例如 `E:\ai\GPT-SoVITS-v4`。
2. 配好音色参考音频（`ref/sally_ref.wav` + `.txt`）。适配器自带 `cutReference(视频文件, 起始秒, 时长)`
   可以从番剧/录音里切一段出来，`separateVocals()` 可以先去掉一遍背景声——
   切完**必须亲耳听一遍**，混进 BGM 或第二个人的声音会串味。
3. 二选一告诉适配器整合包在哪：
   - 设环境变量（推荐，不动代码）：
     ```bat
     set VOICE_TTS_GSV_DIR=E:\ai\GPT-SoVITS-v4
     ```
   - 或**不改代码**：把整合包直接放到 `packages/voice-out/engines/GPT-SoVITS`，
     或在同目录写一个 `gsv-dir.txt`（首行 = 整合包绝对路径）。
     代码按「环境变量 → gsv-dir.txt → ./GPT-SoVITS」顺序解析，**不含任何本机路径**。
4. 自检：
   ```bat
   cd <你的 voice-tts 目录>
   node tts-core.cjs "这是一条语音测试。"
   ```
   第一次会拉起 FastAPI 服务（模型加载要等几十秒），成功时打印 `OK {"path":…,"bytes":…,"ms":…}`。

> 语音库音频条那一半**不需要 GPT-SoVITS**：只要有一个 `audio/` 目录放现成音频就能用。
> TTS 只影响"AI 用自己的话实时合成一条语音"。

---

## 二、语音输入：sherpa-onnx SenseVoice（语音 → 文本）

### 要什么

| 项 | 说明 |
|---|---|
| 模型 | SenseVoice **int8** onnx：`model.int8.onnx` + `tokens.txt`，放 `<engine>/model/`（本机那两份是 239 MB + 316 KB） |
| Node 依赖 | 装在 `<engine>/node_modules/`（适配器按相对路径 require，不装进 bridge 仓库） |
| ffmpeg | 适配器按 `<engine>/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe` 找 |
| 语言 | 中/英/日/韩/粤（`senseVoice` 配置里写死 `language: 'zh'`，改这个字段可切） |

### 哪里下

- sherpa-onnx 官方仓库：<https://github.com/k2-fsa/sherpa-onnx>
- SenseVoice 预训练模型页（**在这里挑 int8 那一项**）：<https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html>
- 模型 HuggingFace 镜像：<https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17>
- 通用 ffmpeg（不装 `@ffmpeg-installer` 时用）：<https://www.gyan.dev/ffmpeg/builds/> 或 <https://ffmpeg.org/download.html>

### 接入步骤

在 `<你的 voice-stt 目录>` 里执行：

```bat
npm init -y
npm i sherpa-onnx-node@^1.13.8 silk-wasm@^3.7.1 @ffmpeg-installer/win32-x64@^4.1.0
mkdir model
:: 把下载到的 model.int8.onnx 和 tokens.txt 放进 model/
```

三个包就是本机 `voice-stt/package.json` 里实际用的依赖和版本（照抄即可）。

自检：`packages/voice-in/engines/stt-core.cjs` 的 `available()` 只检查这三个文件是否存在——
`ffmpeg.exe`、`model/model.int8.onnx`、`model/tokens.txt`，全在就返回 `true`。
剩下的端到端验证放在 [voice-in/README.md](packages/voice-in/README.md) 的自检小节。

### 两个必须知道的坑（照抄本机记录）

1. **QQ 语音的扩展名不可信**：实际收到的语音文件后缀常常是 `.amr`，内容却是 SILK
   （头部 `0x02` + `#!SILK_V3`）。适配器用 `isSilk()` 按内容判，不按后缀。
2. **silk-wasm 必须吃原始缓冲区**：要把开头的 `0x02` 前缀一起喂进去，
   自己剥掉前缀会得到 `silk decoding failure`。

---

## 三、两块共用的通用依赖

| 依赖 | 用途 | 说明 |
|---|---|---|
| ffmpeg / ffprobe | 探测时长、音量处理、格式转换 | 无 ffmpeg 时语音输出会退化成"跳过音量处理"；STT 侧则完全不可用 |
| Node.js | 全部是 ESM/CJS 脚本 | 与你跑 DSH 的 Node 一致即可 |

> 设计上刻意把重依赖都留在**仓库外**：`qq-bridge-main` 里不装任何模型和二进制，
> 桥接只按绝对路径 `require` 这两个 `*-core.cjs`。好处是换引擎/换音色不动 bridge 代码；
> 代价是这两条路径必须在配置里写对，写错的表现是"静默退回文本 / 退回 `[语音]` 占位"。
