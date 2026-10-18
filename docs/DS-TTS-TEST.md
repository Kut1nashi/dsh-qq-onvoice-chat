# 交给 DS 的 TTS 测试任务

请在用户实际运行 GPT-SoVITS 的本机测试本项目的 TTS 改进，提交可复核的结果。
最新 `tts-realtest-feedback-v4-20261018.md` 已验证提交 `0b4acc4`：探活/进程复用、
默认90秒三并发（3/3，总19.12秒）及缺原文预检通过。DS给出代码层可以合并的建议。
当前文档更新不改变已测运行代码；听感、冷启动和QQ端到端尚未完成。
不要把模拟结果、通过的单元测试或首次请求耗时写成真实冷启动和音质结论。
用户确认的网关发行版本为 `@snowluma/runtime v1.14.20`。已核对对应GitHub标签中的
内联音频支持与await发送链路；仍需在该发行包及实际bridge.js中完成本节的端到端验证。

## 可以直接交给 DS 的任务

> 阅读本文件及 `docs/TTS-IMPROVEMENT-LOG.md`，复用v4已验证的引擎和参考材料，
> 先补充原始 `report.json`、实际语言参数及代表性WAV的试听记录。
> 核对实际测试的 `tts-core.cjs` 是本次更新的版本，记录引擎源码哈希、模型、GPU与配置。
> 已通过的探活、90秒三并发与缺原文检查不必为这次文档更新重复执行；运行代码或部署变化时再回归。
> 检查漏字、复读、数字/英文读法、音色及首尾完整性，实际bridge检查80/81字符门槛。
> 冷启动仅在停机窗口验证；QQ端到端在获准指定测试会话后进行，分别记录转码、发送与回读。
> 不能测试的项目标记 BLOCKED，并写清缺少的依赖；无法听取音频则把听感标记为未评估。
> 输出 `DS-TTS-RESULT.md`，附原始报告位置、复现命令、问题清单及有证据支持的优化建议。

## v4之后待完成的验证

| 项目 | 已有证据 | 下一步 |
|---|---|---|
| 冷启动 | 未测；300秒为保守预算 | 停机窗口单独测，不在内存不足时额外拉起一套模型 |
| 主观音质/音色 | 有生成WAV，尚未试听 | 按第5节记录具体文本、时间点、漏字/复读/错读/音色表现 |
| bridge与QQ | v1.14.20源码兼容、模拟消费测试通过 | 在实际接线验证80/81字符门槛、开关/额度与文件清理；获准发送后测转码/送达/回读 |
| 数据归档与速度对照 | v4基准runs=1，报告语言参数未列出 | 保留原始JSON/WAV与语言设置；需要证明加速时同条件交替多轮A/B |

80字符约35–45秒是报告估算，不是实测。80字符作为默认自动语音策略，
超长完整退回文本；按实际聊天需求调整配置时，需补测对应长度和超时率。

## 回归清单与复现命令

请重新下载PR #1当前分支，勿复用 `494449c5` 解压版。若无Git，用引擎SHA256和包内清单记录版本。
本轮为文档更新，v4运行代码可继续作为实机基线。先保留当前外部API，不额外启动模型实例；机器内存不足时继续跳过冷启动。
预检以下四处应为新值：引擎、`voice-out.tts.js`、`config.example.json`、测速脚本。
默认应为排队90000ms、启动300000ms、桥接最多80字符；HTTP推理仍120000ms。
实际bridge的旧显式配置需同步修改，默认值不会覆盖已设置的15000/180000/200。

| 优先级 | 验证 | 通过条件 |
|---|---|---|
| P0 | 在既有服务仍运行、裸GET `/tts` 为500的条件下调用新版 | `probe()`为true、`ensureServer().started`为false；合法POST出WAV，无额外Python进程/端口占用错误 |
| P0 | 合法POST本身返回400/500时 | 透传服务端原因并退回文本，不把业务错误变成第二次启动 |
| P1 | 默认90秒预算三条并发短句 | 分别记录 `queueMs`、`slotMs`、总耗时、成功/失败；目标3/3，失败也完整保留 |
| P1 | 实际桥接中80/81字符边界 | 80字符进入合成，81字符直接完整发文本、不截断、不合成；若测纯逻辑，不发QQ |
| P1 | 缺失/空白参考原文 | `available()` false、`needsReference()` true；直接合成在联网/启动前提示原文，显式非空 `promptText`可覆盖默认txt |
| P2 | 语言与听感 | 参考原文为日语时设 `promptLang=ja`、中文目标 `textLang=zh`，保存设置和WAV；单独记录与旧语言条件的差异 |

已有本地API时可先在仓库根目录检查复用（默认参考材料须已就位）：

```powershell
Get-NetTCPConnection -LocalPort 9880 -State Listen | Select-Object OwningProcess
node -e "const t=require('./packages/voice-out/engines/tts-core.cjs'); (async()=>{const alive=await t.probe();console.log('probe=',alive);if(!alive)throw new Error('端口未响应，请先检查现有服务');console.log('server=',await t.ensureServer());})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>t.stop());"
Get-NetTCPConnection -LocalPort 9880 -State Listen | Select-Object OwningProcess
```

应输出 `probe=true`、`started:false`，前后监听进程一致。若 `probe=false`，先检查地址、端口和代码哈希，
不要反复执行以尝试加载第二套模型。此步骤只证实HTTP存活，不代表推理成功。
离线真实回环HTTP用例使用固定波形；DS v4另已完成实际API与真实合成复核。

日语参考材料的主要复跑命令（先设置下一节的路径变量）：

```powershell
node scripts/benchmark-tts.mjs --engine packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --prompt-lang ja --text-lang zh --label feedback-fix --runs 2 --concurrency 3
```

共12次合成：首次1次、4语料各2次、并发短句3次。确认报告显示90000ms及ja/zh，
实际耗时可能数分钟；107字符长句用于引擎压力观察，不受自动回复80字符门槛限制。
若要与旧报告比较速度，先确认其语言配置；无法确认则标记未完成同条件A/B。
如需重现旧队列问题，另加 `--queue-timeout-ms 15000` 并改标签；不要覆盖成功报告。

DS v4已证明这台机器默认90秒队列的三条短句3/3成功；300秒冷启动尚未测试。
上述命令保留供部署或代码变化后的回归，不要求仅为文档更新重复跑模型。

## 1. 确认环境与代码

在仓库根目录执行：

```bash
node --version
git status --short
git rev-parse HEAD
npm run verify
node --check scripts/benchmark-tts.mjs
```

代码包可能没有 `.git`；这种情况下用包内 SHA256 清单和引擎文件哈希记录版本。
需要Node.js ≥18。套件应包含25项冒烟检查、36项TTS回归和8项测速工具测试（共69项）。
云端因沙箱EPERM跳过1项回环HTTP监听，其余68项通过；0b4acc4的CI与DS本机已补测。
CI日志为69项通过、零跳过，DS报告列出其中44项Node测试通过。
如果运行器只按文件汇总，可以单独执行：

```bash
node tests/tts.test.mjs
node tests/tts-benchmark.test.mjs
```

记录 Node版本、系统、CPU/GPU、显存、驱动/CUDA、Python/Torch、GPT-SoVITS版本、
所用GPT/SoVITS模型、精度设置、推理配置，以及是否有其它GPU任务。
有 NVIDIA 工具时可执行：

```bash
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
```

不要输出访问令牌或整份进程环境变量。

## 2. 准备同一套模型与参考音频

确认整合包里有 `api_v2.py`、推理配置、模型与可用Python。
参考音频建议3~10秒、干净单人声，非空原文必须与音频逐字对应；V3/v4拒绝空原文。
先确认样本能打开，记录采样率、时长、背景声和是否有第二位说话人。

Windows PowerShell 示例，执行前替换占位路径：

```powershell
$env:VOICE_TTS_GSV_DIR = '<GPT-SoVITS整合包完整路径>'
$refAudio = '<参考音频wav完整路径>'
$refText = '<对应原文txt完整路径>'
Get-FileHash packages/voice-out/engines/tts-core.cjs -Algorithm SHA256
```

Linux/macOS 若使用系统Python/ffmpeg，还需设置 `VOICE_TTS_PYTHON`、`VOICE_TTS_FFMPEG`
为可执行文件完整路径，不能只填裸命令名。默认服务地址是 `127.0.0.1:9880`，
如实际不同，设置 `VOICE_TTS_HOST` / `VOICE_TTS_PORT`。

以下以日语参考为例，使用仓库中新适配器并显式传参考音频，避免误用旧部署目录里的代码：

```powershell
node scripts/benchmark-tts.mjs --engine packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --prompt-lang ja --text-lang zh --label after --runs 3 --concurrency 3
```

也可在已配置好默认参考文件的环境直接执行：

```bash
npm run bench:tts -- --label after --runs 3 --concurrency 3
```

默认提交16次合成：1次首次短句、4种语料各3轮、3条同时提交的短句。
只生成本地文件，不调用QQ网关。输出在 `tts-benchmark-results/run-*/`，保留所有报告与试听文件。
每次调用超时可包含300秒启动、120秒HTTP推理与90秒排队预算，完成整组测试可能需要数分钟。
原文与目标语言默认均为zh；日语参考必须加 `--prompt-lang ja`，实际bridge也应同步 `tts.promptLang`。
依赖缺失或首条失败会提前结束并返回非零退出码；保存 `blocked` 报告，不要伪造后续成绩。

## 3. 首次、后续与并发测试

| 项目 | 操作 | 记录/判断 |
|---|---|---|
| 首次调用 | 记录测试前服务是否已响应，执行首次短句 | 总耗时、适配器ms、是否含启动；已运行服务不能称冷启动 |
| 真正冷启动 | 在方便时手动停止专用于测试的服务后重测 | 记录从启动到完整WAV落盘，禁止擅自结束生产服务 |
| 后续合成 | 按4类语料重复测量 | P50/P95、RTF、错误次数、输出时长 |
| 默认并发预算 | 新适配器同时提交3条短句，排队90000ms | 各自总耗时、成功/超时/错误，确认没有死锁 |
| 长队列观察 | 需要时加 `--queue-timeout-ms 120000` | 只用于观察完成顺序，不能替代默认预算的失败率 |

当前 `adapterMs` 只含HTTP与落盘；`wallMs`还包含排队、探活与启动。
新版 `timings` 分别返回 `queueMs`、`serverMs`、`requestMs`、`saveMs`、`slotMs` 和 `totalMs`，
报告同时汇总阶段P95；旧引擎没有分段值时应保留未知，不能用估计替代。
不能将 `wallMs - adapterMs` 全部称为排队，因为其中可能还有服务启动时间。
RTF小于1表示生成速度快于播放速度；实际可接受延迟需结合用户硬件和回复长度判断。
默认只有少量样本，P95仅供观察，需要更稳定的数据时增加 `--runs`，最大30。
报告需分别列成功样本延迟和失败率，不能通过剔除超时请求美化性能。
对CPU或慢设备，额外比较15000/60000/90000ms排队预算；根据真实 `slotMs` / `queueMs` 的P95、
用户能接受的等待与降级率确定配置。三条串行请求中最后一条可能等待前两条完成，
DS旧提交反馈为15秒预算1/3成功、60秒3/3成功；v4已验证默认90秒3/3成功，总19.12秒。
这只覆盖该环境三短句场景，不能推广到任意长度或并发。

## 4. 与旧版做公平对照

若有完整Git仓库，可从本轮交付前的上游提交建立独立工作树：

```bash
git worktree add --detach ../dsh-tts-before 2bf711a386ec8eb6452c29b9d6217f2e30b80545
```

然后在当前仓库用同一个新测速脚本测旧适配器；明确设置 `VOICE_TTS_GSV_DIR`，
显式传入同一个参考音频与原文、相同的目标和参考语言，避免旧版按不同目录寻找引擎。
先用单请求对照，防止把并发策略变化混入推理速度比较：

```powershell
node scripts/benchmark-tts.mjs --engine ../dsh-tts-before/packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --prompt-lang ja --text-lang zh --label before --runs 3 --concurrency 1
node scripts/benchmark-tts.mjs --engine packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --prompt-lang ja --text-lang zh --label after --runs 3 --concurrency 1
```

以上以日语参考为例，中文原文将两条命令均改成 `--prompt-lang zh`。
保持相同GPU、模型、精度、参考音频、原文、语言和服务状态，交替重复两版测试，避免其它GPU负载。
不要拿旧版冷启动与新版已预热比较。对并发结果单独讨论：旧版可能同时访问模型，
新版是单实例串行推理；吞吐、排队和状态隔离是不同指标。
没有旧版可运行时只提交当前版基准，明确“未做真实前后对照”。

## 5. 波形检查与试听

报告提供采样率/声道/时长、峰值/RMS、接近满幅样本占比、首尾和最长静音、静音比例。
静音阈值为20ms窗口RMS低于-45dBFS，轻声可能被识别成静音；接近满幅只提示削波风险。
这些值不能代替听感评分。

| 语料 | 试听重点 |
|---|---|
| short | 首字不丢、尾字不截断、语气自然 |
| medium | 三点半等数字读法、标点停顿、句尾完整 |
| long | 漏字、复读、异常长停顿、音色漂移、背景噪声 |
| mixed | 日期、金额、GitHub/TTS读法和语言切换 |

每类至少试听一段，多轮不一致时检查全部样本。对照旧版时盲听或打乱文件顺序，
记录具体文本、时间位置和问题，不写没有依据的“音质更好”。
若DS无法直接听音频，请标记听感未评估并让用户试听，不能臆造可懂度或音色评分。
有独立ASR时可以补充转写差异，但ASR错误不能直接证明TTS读错。

## 6. 桥接与异常降级

自动化回归已覆盖多数错误路径，先看测试输出。需要在实际桥接验证时，
按 `docs/INTEGRATION.md` 合并新的 `bridge/voice-out.tts.js` 片段；它不能直接作为模块导入。
同步更新 `voice-out.core.js`、两个库文件和13个公共导入，保留
`sendVoiceV2.supportsInlineAudio = true`；只搬运TTS函数遇到旧发送端时应安全降级文本。
确认 `voiceCfg()` 返回 `.tts`，通过日志或测试确认自定义 `queueTimeoutMs` 确实传入引擎。
检查以下行为：

- 合成失败、服务不可用、参考音频/原文缺失、排队超时：回复退回文本，不丢消息。
- 合成后变为静默、关闭开关或额度不足：不继续发语音；产物清理。
- 发送失败也清理本次合成文件；成功发送后才记语音额度。
- 普通文本概率未命中：不触发引擎；对方语音消息仍按原规则触发。
- `stop()`不结束外部服务；启动失败后可以重试，无额外遗留进程。

新增离线回归会并发触发20条回复，在HTTP已返回但模拟网关尚未读取音频时，先清理源文件与音量产物，
再检查20份内联快照都保留完整字节。它证明本项目发送片段不再依赖文件路径，**不是实际QQ压力测试**。

获准实际发送后，用隔离测试会话追加20条网关压力验证：

1. 先记录部署的bridge/SnowLuma版本及是否支持 `record.data.file = base64://...`。
2. 核对20份源WAV均非空；在真实发送链中记录快照字节数、转换产物大小、HTTP结果、messageId及回读。
3. 分别观察正常响应、延迟读取、请求失败/超时后的文件清理；检查接收端是否出现空语音、丢失或截断。
4. 通过TTS入口并发20条时，8条排队上限可能让部分请求按设计退回文本，需将准入降级与网关失败分开计数。
   要单独验证20条网关消费，可预先合成20份样本后走正常发送链，避免把模型队列饱和误判成网关问题。
5. Base64使请求体约增大三分之一；核对网关请求体上限和端到端延迟。
   若部署版本不支持内联音频，应退回文本并先修正接线，不能默默退回路径发送后继续立即删除文件。

未获得真实bridge和网关、缺模型/参考音频或没有实际发送授权时，以上项目标记BLOCKED。
早期截图所述依赖缺失属于上一轮环境边界；后续实机报告已实际运行完整引擎，
本轮应继续复用该环境，不要把早期阻塞当作当前状态或据此重装模型。

本任务默认只做本地合成及可逆验证。实际发QQ消息需用户指定测试会话并明确要求发送。
若获准做端到端测试，分别记录WAV落盘、网关转码、发送响应和回读 `verified`；
没有回读依据不能宣称对方已收到语音。没有桥接/网关时标记BLOCKED，保留本地合成结果。

## 7. 优化实验

先完成基准再优化，每次只改一个变量，保留旧报告与音频。
可以研究桥接启动预热、GPU/半精度、所安装版本支持的批大小/采样步数、切句方法和独立实例。
当前适配器 `batch_size=1`，没有开放 `sample_steps`；调用时塞进选项不会自动生效。
如修改代码做实验，必须注明源码差异、复测离线验证，并比较速度、错误率与试听结果。
不要仅为了更小的数字去删除串行保护、WAV检查、文本降级或发送守卫。
不要把模型流式首包时间当成QQ语音条完整可听时间。

## 8. DS 回传模板

创建 `DS-TTS-RESULT.md`，至少填写：

```markdown
# DS TTS 测试结果
- 时间/系统/Node/Python/Torch：
- 代码提交或源码SHA256：
- 实际测试的引擎路径/是否为新版：
- GPU/显存/模型/精度/服务版本：
- 参考音频时长/采样率/原文是否匹配：
- 目标textLang / 参考promptLang（是否与旧报告一致）：
- 离线测试：PASS / FAIL / BLOCKED（附命令和错误）
- 裸GET状态 / probe结果 / ensureServer.started / 前后监听PID及是否多起进程：
- 首次调用是否真正冷启动/总耗时：
- 后续 short/medium/long/mixed 的P50/P95、RTF、成功数/总数：
- 并发3条各自耗时/排队预算/成功或错误：
- 真实前后对照：已完成 / 未完成（同条件说明）
- 试听：已评估 / 未评估；具体问题及时间位置：
- 桥接与QQ测试：PASS / FAIL / BLOCKED / SKIP：
- 报告JSON/Markdown与WAV目录：
- 已确认的问题、复现步骤与证据：
- 建议优化项、收益依据和音质代价：
- 尚不能下结论的项目：
```

回传原始 `report.json` / `report.md`、测试日志和有代表性的试听文件。
模型、参考音频、个人配置与生成音频不应提交到此源码仓库；测试产物留在本机或单独交付。
