# voice-out —— 语音输出（让 AI 开口说话）

出站方向。两条**互相独立**的出口：

| 出口 | 触发 | 音频来源 | 需要 GPT-SoVITS 吗 |
|---|---|---|---|
| **A. 语音库发送** | AI 调 `qq_send_voice` | `audio/` 里现成的音频文件 | 不需要 |
| **B. TTS 自动语音回复** | AI 回复文本时按概率/按"对方发了语音" | GPT-SoVITS 实时合成 | 需要 |

A 是"AI 挑一条现成的语音条发出去"，B 是"AI 用自己的话和音色说一句"。

## 文件清单

| 文件 | 是什么 | 能不能直接用 |
|---|---|---|
| `lib/voice-core.js` | 音频内核：扩展名表、`listAudioFiles`、`resolveAudioSource`、`safeJoinLibrary`、`inspectAudio`/`describeAudio`、`processAudioVolume`/`resolveAudioProcessing`、`cleanupTemp`、`parseTargetKey`。**纯函数、不读配置单例、无全局副作用** | ✅ 独立可用 |
| `lib/send-voice-lib.js` | 上面内核的再导出层（`bridge.js` import 的就是它） | ✅ |
| `cli/send-voice.mjs` | 命令行发送工具，默认走桥接 `/api/send/voice` | ✅ 放回 `scripts/` |
| `engines/tts-core.cjs` | TTS 适配器：拉起 GPT-SoVITS 的 FastAPI、走 `/tts` 合成、写 wav | ⚠️ 要改路径，见 [`engines/README.md`](engines/README.md) |
| `bridge/voice-out.core.js` | 发送主实现（解析/限流/审计/回读校验） | 📖 参考接线 |
| `bridge/voice-out.tts.js` | `ttsCore()` + `maybeReplyAsVoiceV2()` | 📖 参考接线 |
| `bridge/voice-out.api-*.js` | 三条 HTTP 路由 | 📖 参考接线 |
| `mcp/qq-voice-tools.js` | `qq_send_voice` / `qq_list_voices` 工具定义 | ✅ 原样粘贴 |
| `mcp/tool-flag-map.md` | 工具 → 配置开关映射 | ✅ |
| `console/console-voice-panel.html` | 控制台调试面板（HTML+JS） | ✅ 按注释塞回 |
| `config.example.json` | 输出侧配置模板 | ✅ |

`bridge/` 下的都是**只读参考片段**，不是能直接 `import` 的模块——
它们的函数都是嵌在 `bridge.js` 大闭包里的（依赖 `cfg`、`log`、`agentApi`、`snowlumaHttpAction` 等外部符号）。
请按 [INTEGRATION.md](../../docs/INTEGRATION.md) 第 2 节把它们搬进你的 `bridge.js`。

## 三个设计要点（照抄时别丢）

1. **AI 只能从语音库取文件。**
   `resolveVoicePathForV2` 里，即使开了 `allowAbsolutePath`，绝对路径也**必须落在库目录内**，
   路径里出现 `..` 直接拒。这是防 prompt injection 拿任意本机文件当语音外发。
2. **语音与文本分开限流。**
   `voiceSendTimes` 是独立 Map；`voiceBudgetCheck` 只查不占额度，
   真正发出去后 `voiceBudgetCommit` 才记账——所以不会出现"合成了半天结果被限流白干"。
   默认 6 条/分、60 条/时，可调。
3. **`verified=true` 才算发成功。**
   `verifyVoiceMessageSent` 用 `get_msg` 回读到这条消息的 `record` 段才算落地。
   MCP 工具描述里明确要求 AI"只有 `verified=true` 才能对用户说发了语音"——
   这条约束请在 prompt 层保留，否则 AI 会谎报。

另外：**音量必须在本地先调好**。SnowLuma 的 `record` 段没有增益字段，
所以 `defaultVolume` / `loudness` 是靠 ffmpeg 在发送前处理的，发出去之后就改不了了。

TTS一次性文件通过内部有界内联快照发送，原始WAV及音量产物的清理不依赖网关何时读取路径。
语音库输入的路径边界与URL/base64禁用规则保持不变。
接线时必须一起更新发送片段、TTS片段、`encodeAudioFile` 导入与两个库文件；见接线清单。

## 自检

```bat
:: 1. 内核能不能扫到文件（不需要网关）
node -e "const v=require('./lib/voice-core.js'); console.log(v.listAudioFiles('./audio'))"

:: 2. 适配器单独能不能合成（需要 GPT-SoVITS）
node engines/tts-core.cjs "这是一条测试。"

:: 3. 经桥接列语音库 + 试发（需要桥接已启动）
node cli/send-voice.mjs list-voice
node cli/send-voice.mjs check <音频>
```

音频内核里有个坑值得知道：**ffprobe 结果写临时文件，不走 stdout 管道**。
原因是 DSH 的受限沙箱（workspace-write / 只读）里 `spawn` 一个 `stdio: 'pipe'` 的子进程会直接
`EPERM`，而"继承 stdio + 写文件"是允许的。改这段代码时别顺手改回管道。
