# Changelog

## 2.0.0 — 2026-10-22

把此前推送到 GitHub 的三条工作线合并进 main：`tts-improvements-20261017`（旧版 ffprobe 兼容与探测回归）、`docs/tts-quality-20261018`（TTS 修复线与音质对比素材）、`feat/tts-quality-rep-final`（NF43/R4/HF90 音质后处理组件）。

### TTS 改进线（2026-10-17，2026-10-18 实机复验）


#### Fixed

- 兼容不支持 `-o` 的旧版ffprobe：stdout直接写入临时文件描述符，恢复音频时长探测和健康探测下的maxSeconds限制；覆盖失败退出、超时与输出清理。
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

#### Changed

- 合成从 GET 查询参数改为 POST JSON；同一适配器实例内串行推理，最多等待 8 条。
- 分开限制排队、服务启动和HTTP推理；默认排队90000ms、自动语音80字符、启动300000ms、HTTP120000ms。v5手动启动HTTP33.5/43.8秒；在线预热已复验，适配器spawn/冷态预热仍待复测。
- 实现 `gsv-dir.txt` 路径回退，允许通过环境变量指定 Python 和 ffmpeg 完整路径。
- CI 执行全部离线测试；没有更改模型权重或采样步数，未声称真实推理加速。

#### Added

- 合成阶段计时及报告P95，区分排队、探活/启动、HTTP和落盘。
- 43项TTS回归、8项测速工具测试，保留25项冒烟检查；含真实回环HTTP的GET500复用用例，受限沙箱EPERM时明确跳过并由CI验证。
- 13项ffprobe兼容回归及只读 `scripts/check-audio-probe.mjs`，验证实际二进制探测和时长超限拒绝，复测无需模型合成或QQ发送。
- `warmup({text,...})`显式推理预热，校验并清理产物；`VOICE_TTS_AUTO_START=false`外部守护模式及[部署说明](docs/TTS-OPERATIONS.md)。
- `minAudioSeconds`及测速 `--min-audio-seconds`默认1，0关闭短时长启发式；合成返回增加seconds。
- 测速支持 `--prompt-lang` / `--text-lang` 并记录语言条件；空原文生成blocked报告。
- `npm run bench:tts`：本机语料测速、并发排队观察、WAV 指标、试听清单及 JSON/Markdown 报告。
- [改进日志](docs/TTS-IMPROVEMENT-LOG.md) 与 [交给 DS 的测试说明](docs/DS-TTS-TEST.md)。
- [本机测速指南](docs/TTS-BENCHMARK.md)。be8ffa3本机合并实测：真实合成8.03秒、在线预热15.76秒且清理产物、三并发3/3成功（50.78秒）；51项Node及20项协议通过，碎片/阈值/自动启动开关由替身验证。
- ca334b6阶段只更新验收文档；报告中的main快进只在本机、未推送。保留16.7/76.5秒慢样本，原因未知。
- 后续独立部署v2获DS报告的基础QQ链路与少量试听验证；该部署保留日语情绪方案，不能视为仓库参考片段的全部场景验收。性能长尾及启动降级态根因仍未确认，尚未发布v1.1.0。

### 音质后处理组件（2026-10-19）


#### Added

- 新增 `packages/voice-out/quality/`：NF43 全局降噪 + 可选 R4 局部频谱清理 + 可选 HF90 高频衰减，作用于合成后的音频，不引入新模型权重。
- 新增 `denoise.py`（`nf43-guarded-v1`）：EOF 保护区、按正确方向补偿延迟、参考区间电平匹配（≤1 dB）、一次性 PCM16 量化；无参考区间、增益异常、削波或对齐不可靠时拒绝输出。
- 新增 `r4/`：冻结的 R4 频谱清理、HF90 掩膜、真实子进程 worker 与包装层；只在调用方给出区间时执行，窗外逐样点不变，失败保留上一阶段文件。
- 新增 `postprocess.cjs`：先解析并验证 Python 结果（滤镜串、帧数、削波），再替换原文件；失败保持输入不变。
- 新增公共测试 `tests/quality/`：用运行时生成信号覆盖对齐/EOF/量化/包装层/R4 窗口边界。
- 新增 `docs/TTS-QUALITY-*.md` 三篇说明与 `presets/nf43-r4-hf90-rep-final.json`。

#### Notes

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
