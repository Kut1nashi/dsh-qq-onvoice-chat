# Changelog

## Unreleased — TTS 改进（2026-10-17，2026-10-18实机复验）

### Fixed

- 按DS反馈修复参考 `voiceCfg()` 未透传TTS配置的问题，确保模块路径和排队预算可生效。
- TTS发送改为有大小上限的内联音频快照，移除网关异步读取与临时文件清理的路径依赖；旧发送端安全退回文本。
- 根据DS实机反馈修复阻断回归：裸GET `/tts` 返回500仍表示端口存活，不再重复启动并触发端口冲突；合成POST错误继续透传。
- V3/v4参考原文非空预检，`available()`包含默认原文；缺失/空白在排队、联网及启动前给出中文错误。
- 按v5反馈补充WAV样本帧/时长校验与可配置短音频防护，较长文本默认拒绝不足1秒的碎片并退回文本，短回复与单个英文词豁免。
- 并发启动共用一次启动任务；处理子进程启动错误、信号退出、启动超时和取消。
- 保留运行中服务的进程句柄，避免探活失败后重复启动或遗失管理权。
- 增加 WAV 文件头、流式响应大小限制及写盘失败清理，拒绝空内容和非音频。
- 自动回复在发送成功或失败后清理合成文件，并在合成后重新检查静默、开关和额度。
- 修复 ffmpeg 启动失败后的计时器残留，以及切片失败时把旧参考文件误报为新产物。

### Changed

- 合成从 GET 查询参数改为 POST JSON；同一适配器实例内串行推理，最多等待 8 条。
- 分开限制排队、服务启动和HTTP推理；默认排队90000ms、自动语音80字符、启动300000ms、HTTP120000ms。v5手动启动HTTP33.5/43.8秒，适配器spawn/新预热仍待复测。
- 实现 `gsv-dir.txt` 路径回退，允许通过环境变量指定 Python 和 ffmpeg 完整路径。
- CI 执行全部离线测试；没有更改模型权重或采样步数，未声称真实推理加速。

### Added

- 合成阶段计时及报告P95，区分排队、探活/启动、HTTP和落盘。
- 43项TTS回归、8项测速工具测试，保留25项冒烟检查；含真实回环HTTP的GET500复用用例，受限沙箱EPERM时明确跳过并由CI验证。
- `warmup({text,...})`显式推理预热，校验并清理产物；`VOICE_TTS_AUTO_START=false`外部守护模式及[部署说明](docs/TTS-OPERATIONS.md)。
- `minAudioSeconds`及测速 `--min-audio-seconds`默认1，0关闭短时长启发式；合成返回增加seconds。
- 测速支持 `--prompt-lang` / `--text-lang` 并记录语言条件；空原文生成blocked报告。
- `npm run bench:tts`：本机语料测速、并发排队观察、WAV 指标、试听清单及 JSON/Markdown 报告。
- [改进日志](docs/TTS-IMPROVEMENT-LOG.md) 与 [交给 DS 的测试说明](docs/DS-TTS-TEST.md)。
- [本机测速指南](docs/TTS-BENCHMARK.md)。DS v4/v5复验旧提交功能通过；v5另发现0.32秒异常产物，本轮新防护需实机复测。
- 小样本不据此宣称加速；主观听感、QQ端到端及启动降级态根因仍未确认。尚未发布v1.1.0。

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
