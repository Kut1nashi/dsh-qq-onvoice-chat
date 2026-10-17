# 项目总结：这套语音聊天是怎么长出来的

> 记录的是**已经落地并验证过的实现**（截至 2026-10-18 的仓库快照），不是设想。
> 行号锚点来自 `qq-bridge-main/src/bridge.js` 的对应版本，函数名稳定、行号可能漂移。

## 一、起点与约束

QQ 自动聊天桥接把 DSH 接到 SnowLuma/OneBot 网关上，AI 用 `qq_*` 工具收发消息。
最早的状态是**纯文本**：

- 别人发语音 → 只有 `[语音]` 占位，AI 等于听不见。
- AI 想说话 → 只能打字。

两个约束决定了后来的所有设计：

1. **重依赖不能进桥接仓库**。GPT-SoVITS 整合包 7.5 GB、SenseVoice 模型 239 MB，
   `qq-bridge-main` 里连 `node_modules` 都尽量少。于是引擎全部外置，
   桥接只按绝对路径 `require` 两个 `*-core.cjs` 适配器。
2. **聊天不能因为语音引擎坏了而中断**。所有语音路径都必须能降级回文本。

## 二、四条链路

### 1. 语音输出（出站）

```
AI 调 qq_send_voice
   ↓ resolveVoicePathForV2   只允许语音库内文件（防 prompt injection）
   ↓ voiceBudgetCheck        先查额度，不记账
   ↓ sendVoiceV2             发送 + 文件名审计
   ↓ verifyVoiceMessageSent  get_msg 回读 record 段，verified=true
   ↓ voiceBudgetCommit       真发出去才记账
```

另一条出口是 TTS：`maybeReplyAsVoiceV2` 在"回复对方语音"（100%）或普通文本
（`replyProbability`，默认 0.05）时合成一条。挂载点是统一出站函数
`sendMessagesV2`，且**只有 AI 工具路径传 `allowVoice=true`** —— 否则机器人会用语音念报错。

### 2. 语音输入（入站）

```
record 段
   ↓ fetchRecordAudio   段内 url/path 优先，否则 get_record 要下载地址
   ↓ resolveRecordText  ① 本地 SenseVoice ② QQ 侧 ASR ③ null
   ↓ case 'record'      `[语音转写] …` 或 `[语音]`
```

三条实测结论写进了代码注释：QQ 语音后缀常是 `.amr` 但内容是 SILK；
silk-wasm 必须吃带 `0x02` 前缀的原始缓冲区；QQ 侧 ASR 会 `retcode=100` 失败。

### 3. 自动聊天人格

`qq-chat-v2` preset 把"像真人"拆成可执行的规则：自主决定看/回/潜水、
等待礼仪（首答前短静默 vs 睡前 5 分钟观察）、分条节奏、反 AI 味、记忆卫生、
表情包/拍一拍/语音的克制使用。核心不是文案，而是**工具协议**：
文本输出只是思考，发言必须调 `qq_send_message`。

`qq-tool-restrict` 是硬边界：`tools.restrict` 在注册期把本地执行/文件工具从 schema 里删掉，
`tools.guard` 在执行期兜底。只隐藏不 restrict 是不够的——工具名还在 schema 里就会诱导模型去调。

### 4. 模式控制台

`qq-mode-console` 只做一件事：把 `qq-mode` 命名空间暴露给 DSH 设置，
让桥接控制台能切换 `chat / closed-agent / reserved / reserved2 / simulation`。
踩过的坑：entry id 必须等于命名空间名，字段必须 `.volatile()`。

## 三、关键设计决策

| 决策 | 原因 |
|---|---|
| 音量在**本地**用 ffmpeg 调 | SnowLuma `record` 段没有增益字段，发出去就改不了 |
| 语音限流独立于文本 | 语音更打扰，额度不该互相挤占 |
| `voiceBudgetCheck` / `Commit` 分离 | 避免"合成成功但发送被限流"白干 |
| AI 通道与操作者通道分离 | AI 只能发库内文件，CLI/控制台可放宽 |
| `verified` 回读 | 否则 AI 会谎报"已发语音" |
| ffprobe 写临时文件而非 stdout 管道 | DSH 受限沙箱里 `spawn + pipe` 会 EPERM |
| 语音输入在消息段层降级 | 引擎坏了只影响那一条语音，不影响整轮对话 |

## 四、踩过的坑（都已写进代码注释）

1. **SILK 的扩展名会骗人**：`.amr` 内容是 SILK，按内容判魔数。
2. **`0x02` 前缀不能剥**：剥了 `silk-wasm` 直接 `silk decoding failure`。
3. **`!== false` 的开关语义**：缺字段 = 启用，只有显式 `false` 才关。
   判断"到底开没开"只能看 `config.json`，不能看代码默认值。
4. **两条开关分开**：`voice.enabled`（发送）与 `localStt.enabled`（接收）互不影响。
5. **控制台文件名 XSS**：语音库文件名是外部数据，必须转义。
6. **restrict 名单里的假工具名会静默失效**：`tools.restrict()` 对未知名字抛错被逐个吞掉，
   所以名单要跟 DSH 真实工具名对账。

## 五、验证范围（诚实边界）

已验证：

- 语音内核纯函数：`npm test` 覆盖来源解析、库内边界、格式化、目标 key、音量、文件名净化。
- 桥接内集成测试脚本（`tests/bridge/`）：主链路、边界、音量、预览、系统级。
- 两端适配器在本机（Windows）跑通过：TTS 合成、STT 转写、SILK 解码。

未验证 / 未知：

- **跨平台端到端**：Linux/macOS 需要改 ffmpeg 与 python 路径常量，未实测。
- **模型版本对应关系**：本机模型目录没有来源说明，无法确认具体发布版。
- **他人环境安装成功率**：取决于引擎路径与参考音频是否配对。

## 六、后续可做

- 把 `bridge/` 参考片段做成真正的可 import 模块（抽掉闭包依赖）。
- 提供 Docker Compose 一键起 GPT-SoVITS + bridge。
- Linux/macOS 的 ffmpeg 发现逻辑改为 `which` 优先。
