# 测试

## 离线冒烟（CI 跑这个）

```bash
npm test          # 语音内核冒烟 + TTS 回归测试
npm run check     # node scripts/check-syntax.mjs
```

`smoke.mjs` 只依赖 Node 内置模块，验证语音内核的纯函数：来源解析、库内边界、
体积/时长格式化、目标 key、音量档位、文件名净化。

`tts.test.mjs` 使用 Node 内置测试框架，在临时目录中加载真实 TTS 适配器，模拟
HTTP 响应和子进程事件。覆盖服务复用、并发启动、进程异常/超时/停止、JSON POST、
WAV 与大小校验、响应体读取超时、有界串行队列，以及桥接文本降级和临时文件清理。
不需要 GPT-SoVITS、网络、模型或 QQ 网关；不验证真实模型音质。
当前TTS回归包含32项，额外覆盖配置透传、分阶段计时、旧发送端降级、内联快照大小限制，以及
20条回复在源文件删除后才模拟网关读取的场景；后者不等于真实网关压力测试。

`tts-benchmark.test.mjs` 用已知波形验证测量误差、静音/削波提示，以及完整命令的报告与音频输出。
它使用固定适配器做功能验证，不能作为 GPT-SoVITS 速度或效果测试。
真实合成基准请见 [TTS-BENCHMARK.md](../docs/TTS-BENCHMARK.md)。

## 桥接内集成测试

`bridge/` 下 5 个脚本原本位于 `qq-bridge-main/scripts/`，**依赖桥接仓库结构**
（会 import `../src/bridge.js` 并断言路由/守卫实现存在），所以不随本仓库的 CI 跑。

用法：把它们复制回你的 `qq-bridge-main/scripts/`，并让 `src/` 下存在
`voice-core.js` / `send-voice-lib.js` 后执行：

```bash
node scripts/test-voice.mjs          # 主链路
node scripts/test-voice-edge.mjs     # 边界：空文件 / 超时 / 超限 / 库外路径
node scripts/test-voice-volume.mjs   # 音量与 loudness
node scripts/test-voice-preview.mjs  # 预览
node scripts/test-voice-system.mjs   # 系统级
```

> 默认**不真发语音**（真发会产生不可撤回的 QQ 消息）。要真发用 CLI：
> `node scripts/send-voice.mjs check <音频>` 先探测，再 `send`。
