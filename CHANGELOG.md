# Changelog

## 1.0.0 — 2026-10-18

首次公开发布。

### Added

- `packages/voice-out`：音频内核、CLI、GPT-SoVITS 适配器、发送主实现、3 条 HTTP 路由、
  `qq_send_voice` / `qq_list_voices` MCP 工具、控制台面板、配置模板。
- `packages/voice-in`：sherpa-onnx SenseVoice 适配器（SILK → wav → 文本）、
  加载链与三级降级、`record` 段消息构建。
- `plugins/qq-agent-presets`：`qq-chat` / `qq-chat-v2` 人格 preset 与 `qq-tool-restrict` 工具白名单。
- `plugins/qq-mode-console`：DSH `qq-mode` 设置命名空间。
- `docs/`：环境部署、接线清单、项目总结。
- `tests/smoke.mjs`：离线冒烟测试；`tests/bridge/`：桥接内集成测试（保留原样）。

### Changed

- 适配器与桥接片段去除本机绝对路径：`tts-core.cjs` 改为
  `VOICE_TTS_GSV_DIR → gsv-dir.txt → ./GPT-SoVITS`；`voice-in.stt.js` 改为
  `localStt.module → VOICE_STT_MODULE`；`try-stt.mjs` 改为 `QQ_BRIDGE_CONFIG`。
- `try-stt.mjs` 的 `messageId` 由硬编码默认值改为必填参数。

### Removed

- 本机 `config.json`、`.bak` 备份、`node_modules`、模型、音频库内容。
