# 安全说明

## 报告问题

请通过 GitHub **Private vulnerability reporting**（仓库 Security 标签页）提交，
不要开公开 issue。请附：复现步骤、影响范围、DSH 与桥接版本。

## 威胁模型

这个包把「让 AI 发送本机文件」和「把外部语音喂进模型」两件事接进了聊天链路，
主要风险与对策：

| 风险 | 对策 | 落点 |
|---|---|---|
| Prompt injection 让 AI 外发本机任意文件 | AI 通道只能解析语音库**目录内**文件，`..` 直接拒 | `voice-out.core.js` → `resolveVoicePathForV2` |
| AI 冒充"已发语音" | `get_msg` 回读 `record` 段，`verified=true` 才算成功 | `verifyVoiceMessageSent` |
| 语音洪水刷屏 | 独立限流（默认 6/分、60/时），先查后记 | `voiceBudgetCheck` / `voiceBudgetCommit` |
| 上传文件名 XSS | 控制台渲染文件名必须转义 | `console-voice-panel.html`（含原作者标注） |
| 恶意/超大语音卡死转写 | 下载后、识别前卡 `maxBytes`（默认 20 MB） | `voice-in.stt.js` → `transcribeRecordLocally` |
| 仿真会话拿到本机执行能力 | 注册期 `tools.restrict` + 执行期 `tools.guard` 双保险 | `plugins/qq-agent-presets/qq-tool-restrict.mjs` |
| 令牌泄露 | 仓库不含任何 token；`x-agent-token` 只从请求头/参数读 | `voice-out.api-*.js` |

## 部署建议

- 桥接控制台（`consolePort`）不要直接暴露到公网；需要远程访问请走 SSH 隧道或反代 + 认证。
- `socialV2.voice.enabled` 与 `tools.sendVoice` 默认关；确认语音库内容合规后再打开。
- TTS 参考音频涉及他人声音权/著作权时，自行确认授权。
- 定期检查 `audio/` 目录 —— 那是 AI 唯一能外发的文件集合。
