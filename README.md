# DSH QQ Voice Chat

[DeepSeek Harness](https://github.com/deepseek-ai) 上跑 **QQ 自动聊天**时，让 AI **会说话（TTS）**、
**听得懂语音（STT）**、并带着一套**像真人的聊天人格**的完整套件。

从 `qq-bridge-main`（QQ 自动聊天桥接，SnowLuma/OneBot 网关 + DSH）里把语音子系统与聊天插件
整理成独立包：两条语音链路互不依赖，插件可单独装。

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)

---

## 三条链路

| 能力 | 方向 | 实现 | 目录 |
|---|---|---|---|
| **AI 开口说话** | 出站 | 本地 GPT-SoVITS 零样本克隆，或从语音库挑现成音频 | [`packages/voice-out/`](packages/voice-out/README.md) |
| **AI 听懂语音** | 入站 | 本地 sherpa-onnx SenseVoice（SILK → 16k wav → 文本），QQ 侧 ASR 兜底 | [`packages/voice-in/`](packages/voice-in/README.md) |
| **AI 像真人聊天** | 人格 | DSH agent preset（人格提示词 + 工具白名单硬边界） | [`plugins/qq-agent-presets/`](plugins/qq-agent-presets/README.md) |
| 聊天模式控制台 | 设置 | DSH settings 命名空间 `qq-mode` | [`plugins/qq-mode-console/`](plugins/qq-mode-console/README.md) |

出站两条出口：

- **A. 语音库发送** —— AI 调 `qq_send_voice`，只能发 `audio/` 里的文件（不需要 TTS 引擎）。
- **B. TTS 自动回复** —— AI 回复文本时按概率、或"对方刚发语音"时，用自己的音色合成一条（需要 GPT-SoVITS）。

入站三级降级：**本地 STT → QQ 侧 ASR → `[语音]` 占位**。任何一级失败都不会把聊天打断。

## 包里有什么

```
packages/voice-out/
├─ lib/voice-core.js          音频内核：列库 / 解析来源 / 体积时长 / 音量处理（纯函数，可独立用）
├─ lib/send-voice-lib.js      再导出层（bridge.js import 的就是它）
├─ cli/send-voice.mjs         CLI：list / list-voice / send / check / status
├─ engines/tts-core.cjs       GPT-SoVITS 适配器（不含模型）
├─ bridge/voice-out.*.js      接线参考：发送主实现、TTS 决策、3 条 HTTP 路由、挂载点
├─ mcp/qq-voice-tools.js      qq_send_voice / qq_list_voices 工具定义
├─ console/                   DSH 控制台调试面板
└─ config.example.json

packages/voice-in/
├─ engines/stt-core.cjs       SILK 解码 → ffmpeg → SenseVoice（不含模型）
├─ engines/try-stt.mjs        端到端自测
├─ bridge/voice-in.stt.js     加载链 / 取音频 / 转写优先级
├─ bridge/voice-in.record.js  record 段 → `[语音转写] …` / `[语音]`
└─ config.example.json

plugins/
├─ qq-agent-presets/          qq-chat / qq-chat-v2 人格 + qq-tool-restrict 工具白名单
└─ qq-mode-console/           DSH settings 插件（qq-mode 命名空间）

docs/                        环境部署、接线清单、项目总结
tests/                       冒烟测试 + 桥接内集成测试
scripts/                     语法检查 / 发布到 GitHub
```

**不含**（刻意留在仓库外，见 [docs/ENV-SETUP.md](docs/ENV-SETUP.md)）：

- GPT-SoVITS 整合包（约 7.5 GB）
- SenseVoice 模型（`model.int8.onnx` 约 239 MB + `tokens.txt`）
- `node_modules`、ffmpeg 二进制、参考音频、`audio/` 语音库内容
- 任何 `config.json`（只给 `*.example.json`）、任何令牌或本机绝对路径

## 快速开始

### 1. 装引擎（任意位置，不用和作者同路径）

```bat
:: 语音输出
set VOICE_TTS_GSV_DIR=E:\ai\GPT-SoVITS-v4
:: 语音输入
mkdir voice-stt && cd voice-stt
npm init -y && npm i sherpa-onnx-node@^1.13.8 silk-wasm@^3.7.1 @ffmpeg-installer/win32-x64@^4.1.0
mkdir model
:: 把 model.int8.onnx / tokens.txt 放进 model/，把 stt-core.cjs 复制过来
```

细节与官方下载地址：[docs/ENV-SETUP.md](docs/ENV-SETUP.md)。

### 2. 接进你的 `qq-bridge-main`

```bat
copy packages\voice-out\lib\voice-core.js     <bridge>\src\voice-core.js
copy packages\voice-out\lib\send-voice-lib.js <bridge>\src\send-voice-lib.js
```

其余按函数边界搬运：[docs/INTEGRATION.md](docs/INTEGRATION.md)。

### 3. 配置并打开开关

把 [`packages/voice-out/config.example.json`](packages/voice-out/config.example.json)
与 [`packages/voice-in/config.example.json`](packages/voice-in/config.example.json) 合并进 `config.json`。

> [!IMPORTANT]
> 发送侧要生效必须**同时**为 `true`：
> `socialV2.voice.enabled` 与 `socialV2.tools.sendVoice`。
> 接收侧只看 `socialV2.voice.localStt.enabled`，两者互不影响。

### 4. 自检

```bat
node packages/voice-out/engines/tts-core.cjs "这是一条语音测试。"
node -e "const s=require('./packages/voice-in/engines/stt-core.cjs'); console.log(s.available())"
node packages/voice-out/cli/send-voice.mjs list-voice
```

本仓库自带可离线跑的测试：

```bat
npm test
```

## 安装插件（可选）

```bat
:: 以 link: 方式装进 DSH profile 的 node_modules
npm i link:<本仓库>\plugins\qq-agent-presets link:<本仓库>\plugins\qq-mode-console
```

再按各插件 README 把 patch 行加入 profile。插件版本对应 DSH **0.1.7**。

## 安全边界

1. **AI 只能从语音库取文件**：`resolveVoicePathForV2` 里即使开 `allowAbsolutePath`，
   绝对路径仍必须落在库目录内，含 `..` 直接拒——防 prompt injection 把本机任意文件当语音外发。
2. **语音与文本分开限流**：独立 `voiceSendTimes` Map；`voiceBudgetCheck` 只查不记，
   真发出去才 `voiceBudgetCommit`，不会"合成完才发现被限流"。
3. **`verified=true` 才算发成功**：`get_msg` 回读确认 `record` 段落地，否则 AI 会谎报。
4. **控制台文件名必须转义**：语音库文件名是外部数据，`x<img src=x onerror=...>.mp3` 可注入脚本。
5. **语音输入永不阻断聊天**：任何引擎故障都降级到 `[语音]` 占位。
6. **本地工具硬隔离**：`qq-tool-restrict` 在注册期剔除执行/文件类工具，`tools.guard` 兜底拒绝。

## 兼容性与限制

- Node.js **≥ 18**（用到 `fetch`、`AbortSignal.timeout`）。
- 默认按 **Windows** 路径（`runtime/python.exe`、`@ffmpeg-installer/win32-x64`）；Linux/macOS 需改
  `stt-core.cjs` 的 `FFMPEG` 常量与 `tts-core.cjs` 的 `PY` 后缀。
- 语音输出依赖自建 GPT-SoVITS 服务（默认 `127.0.0.1:9880`）。
- 参考音频决定克隆音色，**使用他人声音的授权问题请自行确认**。
- 本包**未做跨平台端到端实测**，验证范围见 [docs/PROJECT-SUMMARY.md](docs/PROJECT-SUMMARY.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ENV-SETUP.md](docs/ENV-SETUP.md) | 两个引擎的安装、下载地址、目录约定 |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | 逐函数接线清单、行号锚点、开关与路由 |
| [docs/PROJECT-SUMMARY.md](docs/PROJECT-SUMMARY.md) | 这套东西是怎么长出来的：能力、决策、踩过的坑 |
| [SECURITY.md](SECURITY.md) | 威胁模型与私密报告方式 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、测试与提交约定 |

## 许可证与来源

MIT。语音子系统与聊天插件派生自 **qq-bridge-main**（Copyright © 2026 Derpyu520 and
qq-bridge / QSH contributors），详见 [NOTICE.md](NOTICE.md)。
