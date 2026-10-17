# 接线清单（接进你自己的 qq-bridge-main）

所有行号对应**本机 2026-10-12 的 `qq-bridge-main` 快照**，你的仓库版本可能已经不同，
但函数名、路由名、开关名是稳定的，按名字搜索即可。

---

## 0. 公共：新建两个模块文件

把语音内核放到桥接仓库里（路径随意，下面按 `src/` 写）：

```bat
copy packages\voice-out\lib\voice-core.js     <你的 qq-bridge-main>\src\voice-core.js
copy packages\voice-out\lib\send-voice-lib.js <你的 qq-bridge-main>\src\send-voice-lib.js
```

`voice-core.js` 是**唯一实现**，`send-voice-lib.js` 只做再导出。
原作者明确要求"不复制实现"，所以如果你还有别的发送入口（独立 CLI、控制台 GUI），
都去 `require` 同一个 `voice-core.js`，不要各拷一份。

然后在 `src/bridge.js` 顶部（原第 28 行）加：

```js
import {
  AUDIO_EXTS, cleanupTemp, describeAudio, encodeAudioFile, formatBytes, formatDuration,
  inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume,
  resolveAudioProcessing, resolveAudioSource, safeJoinLibrary
} from './send-voice-lib.js';
```

> 以上13个符号用于本轮接线，新增 `encodeAudioFile` 供TTS发送内联快照。请同步更新两个库文件。

## 1. 配置节

按 [`packages/voice-out/config.example.json`](packages/voice-out/config.example.json) 与
[`packages/voice-in/config.example.json`](packages/voice-in/config.example.json) 合并进 `config.json`。
**别忘了两个开关**（见根 README「两个开关是分开的」）：发送侧要 `voice.enabled` 和
`tools.sendVoice` **同时**为 `true`。

---

## 2. 语音输出（出站）

### 2.1 核心实现 —— 参考 `packages/voice-out/bridge/voice-out.core.js`

从 `bridge.js` 第 1779-2136 行整块抽出，按顺序包含：

| 函数 | 原行 | 作用 |
|---|---|---|
| `voiceCfg()` | 1779 | 读 `socialV2.voice` |
| `voiceLibrary()` | 1796 | 递归扫语音库，附时长/体积 |
| `voicePathInsideLibrary(vc, absPath)` | 1818 | 判定绝对路径是否落在库内 |
| `resolveVoicePathForV2(input)` | 1825 | **AI 通道**解析：只允许库内文件，`..`/库外绝对路径直接拒 |
| `resolveVoicePathForOperator(input)` | 1901 | **操作者通道**解析（CLI/控制台，可放宽） |
| `voiceBudgetCheck(scopeKey, cfgV)` | 1920 | 只检查不记账，避免"合成成功但发送被限流"白干 |
| `voiceBudgetCommit(scopeKey)` | 1934 | 真正发出后记账，顺带裁掉 1 小时外的旧时间戳 |
| `sendVoiceV2(key, filePath, opts)` | 1948 | 底层发送，做内容审计 |
| `recordVoiceSentV2` / `verifyVoiceMessageSent` | 2033 / 2063 | 记账 + `get_msg` 回读校验语音真的落地 |
| `sendVoiceForV2(key, voiceRef, opts)` | 2098 | 对外主入口：解析 → 校验限流 → 发送 → 记账 |

**三个安全设计别删**（这些是有意的边界，不是冗余）：

1. **AI 只能从语音库取文件**。即使 `allowAbsolutePath: true`，绝对路径仍必须落在库目录内——
   防 prompt injection 把本机任意文件当语音外发。
2. **出站文件名要过敏感信息/会话令牌审计**（原第 1763-1774 行附近）。音频内容审计不了，
   但文件名同样会泄露路径与项目信息。
3. **语音与文本分开限流**（`voiceSendTimes` 独立 Map，原第 1763 行）。语音额度不吃聊天额度。

### 2.2 TTS 自动语音回复 —— 参考 `packages/voice-out/bridge/voice-out.tts.js`

从第 8281-8358 行抽出，含两个函数：

- `ttsCore()`（8281）：按 `socialV2.voice.tts.module` 懒加载 TTS 适配器，加载失败只记日志不抛。
- `maybeReplyAsVoiceV2(key, text)`（8317）：决策 + 合成 + 发送。触发条件：
  - 回复**对方的语音消息** → 100% 用语音；
  - 普通文本对话 → `tts.replyProbability`（默认 `0.05`）。

**必须保留的降级语义**：模块缺失 / 没参考音频 / 限流 / 合成报错 / 文本超 `maxChars`，
任一环节失败都 `return { sent: false, reason }` 退回文本发送，**绝不吞掉回复**。

TTS 适配器为每次调用生成独立文件。发送端在发送槽内用 `encodeAudioFile` 生成受
`voice.maxBytes` 限制的内联音频快照，网关后续处理不再依赖原始/音量处理文件路径。
片段中的 `finally` 删除本次产物，发送失败也会清理。
库内输入解析、审计、限流和发送守卫照常执行；AI仍不能传URL或base64作为音频来源。
Base64传输体积约增加三分之一，需在实际网关验证请求体限制及端到端耗时。
用户使用的 `@snowluma/runtime v1.14.20` 源码已确认支持该音频来源，实际发行包联调仍待完成。

**两个片段必须一起更新**：`voice-out.core.js` 中的 `voiceCfg()` 需透传 `tts: v.tts ?? {}`，
否则模块路径和排队预算不能生效；`sendVoiceV2` 函数及紧接其后的
`sendVoiceV2.supportsInlineAudio = true` 能力声明也须一起搬运。
TTS片段遇到没有此声明的旧发送函数，会在合成前以 `sender-no-inline` 原因退回文本，
避免旧函数忽略 `inline` 参数后仍清理音频路径。

合成后会重新检查静默状态、启用开关和发送额度。
`tts.startTimeoutMs` 默认 180000，`tts.queueTimeoutMs` 默认 15000，
`tts.timeoutMs` 默认 120000；分别限制启动、排队和 HTTP 推理时间，配置示例已包含这些字段。
15秒是默认响应预算。CPU推理可能使三请求中的后两条排队超时；先用本机分阶段计时测量，
再比较30000/45000等候选预算，不能把默认值或协议层测试当成真实性能结论。

接入点在统一出站函数 `sendMessagesV2(key, messages, delays, replyToMessageId, atUserId, allowVoice)`
（原第 8200 行）。整段挂载代码（原第 8200-8211 行，逐字复制）：

```js
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, allowVoice = false) {
    // 自动语音回复的**唯一挂载点**：只有 AI 的工具发送路径会传 allowVoice=true
    // （桥接自己的通知、提示词、错误提示一律不传，永远走文本）。
    // 仅在"单条消息"时考虑语音：多条是刻意的分条节奏，合并成一条语音会破坏它，宁可发文本。
    if (allowVoice && messages.length === 1) {
      return maybeReplyAsVoiceV2(key, messages[0]).then((r) => (
        r?.sent ? [messages[0]] : sendMessagesV2(key, messages, delays, replyToMessageId, atUserId)
      ));
    }
```

三个容易改错的细节：

1. **只有 `allowVoice === true` 才考虑语音**。这个参数只由 AI 的工具发送路径传 `true`；
   桥接自己的通知、提示词、错误提示一律不传——**否则机器人会用语音念报错**。
2. **只处理单条消息**（`messages.length === 1`）。多条是刻意设计的分条节奏，
   合并成一条语音会破坏它，宁可发文本。
3. 递归降级调用**故意不再传 `allowVoice`**（默认 `false`），避免合成失败后在文本路径里再次尝试语音。

同段代码另存为 [`packages/voice-out/bridge/voice-out.mount.js`](packages/voice-out/bridge/voice-out.mount.js) 便于对照。

### 2.3 HTTP 路由 —— 参考 `packages/voice-out/bridge/voice-out.api-*.js`

| 文件 | 原行 | 路由 | 用途 |
|---|---|---|---|
| `voice-out.api-operator.js` | 5943-6054 | `POST /api/voice/send` 或 `/api/send/voice` | 操作者/CLI 通道，`/api/send/voice` 在带 agent token 时会被推到 AI 通道 |
| `voice-out.api-agent.js` | 6056-6121 | `POST /api/socialV2/send-voice` | **AI 通道**，需 `key` + `x-agent-token`，只能发自己那个会话 |
| `voice-out.api-list.js` | 6281-… | `GET /api/socialV2/voices` 或 `/api/voice/list` | 列出语音库（名字、时长、体积、limits） |

AI 通道里两处校验别漏：`v2ToolEnabled('sendVoice')` 与语音库解析走 `resolveVoicePathForV2`
（操作者通道才用 `resolveVoicePathForOperator`）。

### 2.4 MCP 工具

- 工具定义全文：`packages/voice-out/mcp/qq-voice-tools.js`（原 `mcp-snowluma-safe.js` 第 1046-1101 行），
  含 `qq_send_voice` 与 `qq_list_voices`。描述是中文的，**建议原样保留**——
  里面写清了"只能发语音库""`verified=true` 才能说发了语音""别滥用"这些行为约束。
- 开关映射：`packages/voice-out/mcp/tool-flag-map.md`（`qq_send_voice` / `qq_list_voices` → `sendVoice`）。
- 注册守卫（原第 1046 行）：

  ```js
  if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) { … }
  ```

  注意这是 `!== false`，所以**缺字段 = 启用**，只有显式 `false` 才关。

### 2.5 控制台面板（可选）

`packages/voice-out/console/console-voice-panel.html` 里有四段，按注释里的行号塞回你的 `public/console.html`：
工具开关复选框、`<details>` 面板、面板 JS、以及切页时的按需加载钩子。

原作者在这里踩过一个 XSS 坑并在注释里标了：语音库文件名是**外部数据**，
放一个名为 `x<img src=x onerror=...>.mp3` 的文件就能注入脚本，
所以面板渲染文件名时必须转义（原第 3125-3126 行注释）。**照抄面板时别把转义省掉。**

### 2.6 CLI（可选）

`packages/voice-out/cli/send-voice.mjs` 放回 `<qq-bridge-main>/scripts/`：

```bat
node scripts/send-voice.mjs list          :: 有哪些群聊/私聊可发
node scripts/send-voice.mjs list-voice    :: 语音库里有哪些音频
node scripts/send-voice.mjs send <音频> <目标> [选项]
node scripts/send-voice.mjs check <音频>  :: 只探测不发送
node scripts/send-voice.mjs status
```

目标写法：`群号` | `group:群号` | `private:QQ号` | `@昵称/群名`。
默认走桥接 `/api/send/voice`，与 AI 完全同一条闸门（白名单/限流/审计都在桥接里，
避免 CLI 成为后门）；`--direct` 绕过桥接直连 SnowLuma，只用于桥接没启动时排查。

---

## 3. 语音输入（入站）

### 3.1 本地 STT 链路 —— 参考 `packages/voice-in/bridge/voice-in.stt.js`

从第 1399-1530 行抽出：

| 函数 | 原行 | 作用 |
|---|---|---|
| `getLocalSttRequire()` | 1418 | 建 `createRequire`，用来 `require` 仓库外的 `.cjs` |
| `localSttConfig()` | 1423 | 读 `socialV2.voice.localStt` |
| `getLocalStt()` | 1436 | 懒加载引擎；**加载失败只记日志**，后续自动降级 |
| `fetchRecordAudio(data, opts)` | 1451 | 取语音条音频：优先段里的 `url`/本地 `path`，否则用 `get_record` 向网关要下载地址，带超时与体积检查 |
| `transcribeRecordLocally(data, messageId)` | 1472 | 本地转写，超 `maxBytes` 直接跳过 |
| `resolveRecordText(data, messageId)` | 1493 | **优先级链**：本地 STT → QQ 侧 ASR → `null`（调用方退回 `[语音]`） |

### 3.2 `record` 段消息构建 —— 参考 `packages/voice-in/bridge/voice-in.record.js`

从第 1531-1594 行抽出，`case 'record'`（原第 1553 行）产出：

```js
out.push(spoken ? `[语音转写] ${spoken}` : '[语音]');
```

即：转写成功就把文本（带 `[语音转写]` 前缀）喂给 AI 当正常消息，失败就退化成 `[语音]` 占位。
这是让 AI "听懂语音"的最后一步，别把它漏掉——否则引擎再正常，AI 看到的也只是 `[语音]`。

### 3.3 可选：`backfill`

`localStt.backfill: true` + `backfillMax: 10` 让桥接在启动后回填**积压的**未转写语音。
不想要就设 `false`，不影响新消息的实时转写。

---

## 4. 测试脚本

`tests/bridge/` 里 5 个脚本原本位于 `qq-bridge-main/scripts/`，**依赖桥接仓库结构**，
放回那个目录再跑（本仓库 CI 不跑它们）：

```bat
node scripts/test-voice.mjs          :: 主链路
node scripts/test-voice-edge.mjs     :: 边界（空文件/超时/超限/库外路径）
node scripts/test-voice-volume.mjs   :: 音量与 loudness 处理
node scripts/test-voice-preview.mjs  :: 预览
node scripts/test-voice-system.mjs   :: 系统级
```

它们只 import Node 内置模块（`fs`/`os`/`path`/`url`），没有额外依赖；
但会按原仓库的约定去找 `../src/bridge.js` 之类，改目录后要顺手调路径。

---

## 5. 接线自检（建议按序）

```bat
:: ① 引擎本身通不通
node <voice-tts>\tts-core.cjs "测试一句话"          :: 应打印 OK {...}
node <voice-stt>\stt-core.cjs                        :: available() 应为 true

:: ② 语音库能不能列出来（先放 1~2 个音频进 audio/）
node scripts/send-voice.mjs list-voice

:: ③ 端到端：CLI 发一条（不经过 AI）
node scripts/send-voice.mjs check <音频>             :: 先只探测
node scripts/send-voice.mjs send <音频> group:<群号>

:: ④ 最后才开 AI 通道：config.json 里 voice.enabled + tools.sendVoice 都设 true，
::    重启桥接，确认 qq_send_voice / qq_list_voices 出现在工具列表里。
```

排查顺序与表现对照：

| 表现 | 大概率原因 |
|---|---|
| AI 工具列表里没有 `qq_send_voice` | `voice.enabled` 或 `tools.sendVoice` 有一个是 `false`，或桥接没重启 |
| 语音库里看不到文件 | 音频不在 `socialV2.voice.dir` 下，或扩展名不在支持列表里，或超过递归深度 4 |
| "语音只能从语音库取文件" | AI 传了库外的绝对路径 —— **这是设计如此**，改配置放宽要在 `resolveVoicePathForV2` 里权衡安全性 |
| 一直退回文本、日志有 `tts-unavailable` | GPT-SoVITS 整合包路径不对，或 `ref/sally_ref.wav` 不存在 |
| 收到的语音只显示 `[语音]` | 本地 STT 不可用且 QQ 侧 ASR 也失败（对方语音太短/被撤回/网关不支持） |
