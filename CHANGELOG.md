# Changelog

## Unreleased — 音质后处理组件（2026-10-19）

### Added

- 新增 `packages/voice-out/quality/`：NF43 全局降噪 + 可选 R4 局部频谱清理 + 可选 HF90 高频衰减，作用于合成后的音频，不引入新模型权重。
- 新增 `denoise.py`（`nf43-guarded-v1`）：EOF 保护区、按正确方向补偿延迟、参考区间电平匹配（≤1 dB）、一次性 PCM16 量化；无参考区间、增益异常、削波或对齐不可靠时拒绝输出。
- 新增 `r4/`：冻结的 R4 频谱清理、HF90 掩膜、真实子进程 worker 与包装层；只在调用方给出区间时执行，窗外逐样点不变，失败保留上一阶段文件。
- 新增 `postprocess.cjs`：先解析并验证 Python 结果（滤镜串、帧数、削波），再替换原文件；失败保持输入不变。
- 新增公共测试 `tests/quality/`：用运行时生成信号覆盖对齐/EOF/量化/包装层/R4 窗口边界。
- 新增 `docs/TTS-QUALITY-*.md` 三篇说明与 `presets/nf43-r4-hf90-rep-final.json`。

### Notes

- 不含任何音频、参考音频、声源或本地路径；公开测试不依赖私有素材。
- 区间是每条音频自己的，没有自动识别；没有区间只做全局 NF43。
- 0.90 是高频幅度系数，不代表“气声减少 10%”。

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
