# 来源与署名 (Provenance & Attribution)

本仓库的语音子系统与聊天插件派生自 **qq-bridge-main**（QQ 自动聊天桥接，
SnowLuma/OneBot 网关 + DeepSeek Harness），上游为 MIT 许可，
Copyright © 2026 Derpyu520 and qq-bridge / QSH contributors。

## 文件对应关系

| 本仓库路径 | 上游来源 | 处理方式 |
|---|---|---|
| `packages/voice-out/lib/voice-core.js` | `qq-bridge-main/src/voice-core.js` | 原样 |
| `packages/voice-out/lib/send-voice-lib.js` | `qq-bridge-main/src/send-voice-lib.js` | 原样 |
| `packages/voice-out/cli/send-voice.mjs` | `qq-bridge-main/scripts/send-voice.mjs` | 原样 |
| `packages/voice-out/engines/tts-core.cjs` | 本机 `voice-tts/tts-core.cjs` | **去掉本机绝对路径**，改环境变量/相对解析 |
| `packages/voice-out/bridge/*.js` | `src/bridge.js`（按函数边界抽取） | 只读参考片段，非可执行模块 |
| `packages/voice-out/mcp/qq-voice-tools.js` | `src/mcp-snowluma-safe.js` | 只读参考片段 |
| `packages/voice-out/console/*` | `public/console.html` | 只读参考片段 |
| `packages/voice-in/engines/stt-core.cjs` | 本机 `voice-stt/stt-core.cjs` | 原样（不含模型） |
| `packages/voice-in/bridge/*.js` | `src/bridge.js` 1399-1594 | 只读参考片段 |
| `plugins/qq-agent-presets/*` | `qq-bridge-main/plugins/qq-agent-presets` | 原样（去掉 `.bak`） |
| `plugins/qq-mode-console/*` | `qq-bridge-main/plugins/qq-mode-console` | 原样 |

## 公开发布时做过的清理

- 删除 4 处本机绝对路径（`D:/…/voice-tts`、`D:/…/voice-stt`、`D:/…/qq-bridge-main/config.json`），
  改为环境变量 / 相对路径解析。
- 删除 1 个硬编码 QQ `messageId` 默认值，改为必填参数。
- 未包含 `config.json`、`node_modules`、模型、音频库内容、`.bak` 备份。
- 全文扫描确认无 API key、access token、QQ 号、群号。

## 商标

DeepSeek、DeepSeek Harness、QQ、GPT-SoVITS、sherpa-onnx、SnowLuma 等名称归各自权利人所有，
本仓库仅作技术集成说明。
