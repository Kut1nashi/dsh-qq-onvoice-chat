# voice-in —— 语音输入（让 AI 听懂别人的语音）

入站方向。别人发来的**语音条**要变成 AI 能读的文本，链路是：

```
QQ 消息段 record
      ↓
fetchRecordAudio()      段里有 url/path 就用；否则用 get_record 向网关要下载地址
      ↓
resolveRecordText()     ① 本地 STT（sherpa-onnx SenseVoice）—— 首选
                        ② QQ 侧 ASR 转写                        —— 兜底
                        ③ null                                  —— 退回占位
      ↓
case 'record'           spoken 存在 → `[语音转写] ${spoken}`；否则 → `[语音]`
      ↓
喂给 AI 当普通消息文本
```

## 文件清单

| 文件 | 是什么 |
|---|---|
| `engines/stt-core.cjs` | STT 适配器：SILK 解码 → ffmpeg 转 16k 单声道 wav → SenseVoice 识别。**不含模型**，⚠️ 依赖要自己装，见 [`engines/README.md`](engines/README.md) |
| `engines/try-stt.mjs` | 端到端自测脚本：网关取音频 → 解码 → 识别。桥接配置用 `QQ_BRIDGE_CONFIG` 指定 |
| `bridge/voice-in.stt.js` | 本地 STT 加载链 + `record` 音频获取 + 转写优先级（原 `bridge.js` 第 1399-1530 行） |
| `bridge/voice-in.record.js` | 消息段 → 文本的构建逻辑，含 `case 'record'`（原第 1531-1594 行） |
| `config.example.json` | 输出侧配置模板（就一段 `localStt`） |

`bridge/` 下是**只读参考片段**，函数嵌在 `bridge.js` 大闭包内（依赖 `cfg`、`log`、
`snowlumaHttpAction` 等），不能直接 `import`。按 [INTEGRATION.md](../../docs/INTEGRATION.md) 第 3 节搬运。

## 设计要点

1. **三级降级，永远不抛到主流程之外。**
   本地 STT 不可用（模块缺失/模型没下/超体积）→ 试 QQ 侧 ASR → 还是拿不到就 `null`，
   调用方退回 `[语音]` 占位。**聊天不该因为语音引擎坏了就断**。
2. **加载失败只记日志。** `getLocalStt()` 里 `_loadError` 被记住但不上抛，
   避免每条语音都重复尝试加载同一个坏模块。
3. **体积闸门在下载后、识别前。** `maxBytes` 默认 20 MB，超了直接跳过并记日志——
   防一个超大文件把转写卡死。
4. **扩展名不可信，按内容判 SILK。** 见下。

## 两个必须知道的坑

QQ 语音文件后缀常是 `.amr`，但**内容是 SILK**（头部 `0x02` + `#!SILK_V3`）。
并且 **silk-wasm 必须吃原始缓冲区**——把开头的 `0x02` 前缀一起喂进去，
自己剥掉前缀会得到 `silk decoding failure`。
`stt-core.cjs` 里的 `isSilk()` 就是干这个的，改代码时别"顺手清理"那个 `0x02`。

## 配置

只影响输入侧的字段（`socialV2.voice.localStt`）：

```json
"localStt": {
  "enabled": true,
  "module": "<你的 voice-stt 目录>/stt-core.cjs",
  "maxBytes": 20971520,
  "downloadTimeoutMs": 60000,
  "backfill": true,
  "backfillMax": 10
}
```

`backfill` 是"启动后回填积压的未转写语音"，不想让它补历史就设 `false`，
不影响新消息的实时转写。

> 注意：`socialV2.voice.enabled`（发送侧开关）**不影响**这一侧。
> 本机 `config.json` 里 `voice.enabled` 是 `false`，但 `localStt.enabled` 是 `true`，
> 也就是转写在跑、发语音没开。

## 自检

```bat
:: 1. 适配器能不能用（只看依赖是否齐）
node -e "const s=require('./engines/stt-core.cjs'); console.log(s.available())"
:: 需要 true；false 就是 ffmpeg.exe / model/model.int8.onnx / model/tokens.txt 缺一个

:: 2. 拿一个真实语音条跑一遍（SILK / amr / wav 都行）
node -e "const s=require('./engines/stt-core.cjs'); s.transcribeFile('<语音文件>').then(r=>console.log(r))"
:: 期望拿到 { text: '…', ms: N }；text 为空说明音频本身没内容或格式不对

:: 3. 端到端：让群里/私聊里有人发一条语音，看桥接日志
::    [local-stt] 语音条 … 本地转写成功（…ms，取音频 …）：…
::    或 [voice] 语音条 … 转写成功：…
::    失败会看到 [local-stt] … 失败，改用 QQ 侧 ASR
```

常见失败：

| 日志/表现 | 原因 |
|---|---|
| `本地语音转写加载失败` | `module` 路径写错，或那个目录里没装 `node_modules` |
| `超过体积上限` | 语音条大于 `maxBytes`，按需调大 |
| `拿不到语音下载地址` | 段里既无 `url` 也无 `file`，且 `get_record` 也没返回 |
| 一直 `[语音]` | 本地 STT 和 QQ 侧 ASR 都失败——先单独跑上面第 2 步，把问题定位到引擎还是网关 |
