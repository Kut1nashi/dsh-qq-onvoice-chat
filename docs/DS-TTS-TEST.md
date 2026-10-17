# 交给 DS 的 TTS 测试任务

请在用户实际运行 GPT-SoVITS 的本机测试本项目的 TTS 改进，提交可复核的结果。
本次云端只完成离线验证和固定响应开销测量，真实模型速度与音质尚未测量。
不要把模拟结果、通过的单元测试或首次请求耗时写成真实冷启动和音质结论。

## 可以直接交给 DS 的任务

> 阅读本文件及 `docs/TTS-IMPROVEMENT-LOG.md`，先检查依赖并运行全部离线测试，
> 再使用实际 GPT-SoVITS、同一参考音频及对应原文运行本机基准。
> 核对实际测试的 `tts-core.cjs` 是本次更新的版本，记录引擎源码哈希、模型、GPU与配置。
> 测量首次和后续延迟、RTF、三请求排队、失败率，保存报告和音频，
> 检查漏字、复读、数字/英文读法、音色及首尾完整性。
> 不能测试的项目标记 BLOCKED，并写清缺少的依赖；无法听取音频则把听感标记为未评估。
> 输出 `DS-TTS-RESULT.md`，附原始报告位置、复现命令、问题清单及有证据支持的优化建议。

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
需要 Node.js ≥18。离线测试应包含25项冒烟检查、27项 TTS 回归和6项测速工具测试。
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
参考音频建议3~10秒、干净单人声，其原文必须与音频逐字对应。
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

以下示例使用仓库中的新适配器，显式传参考音频，避免误用旧部署目录里的代码：

```powershell
node scripts/benchmark-tts.mjs --engine packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --label after --runs 3 --concurrency 3
```

也可在已配置好默认参考文件的环境直接执行：

```bash
npm run bench:tts -- --label after --runs 3 --concurrency 3
```

默认提交16次合成：1次首次短句、4种语料各3轮、3条同时提交的短句。
只生成本地文件，不调用QQ网关。输出在 `tts-benchmark-results/run-*/`，保留所有报告与试听文件。
每次调用超时可包含180秒启动、120秒HTTP推理与15秒排队预算，完成整组测试可能需要数分钟。
依赖缺失或首条失败会提前结束并返回非零退出码；保存 `blocked` 报告，不要伪造后续成绩。

## 3. 首次、后续与并发测试

| 项目 | 操作 | 记录/判断 |
|---|---|---|
| 首次调用 | 记录测试前服务是否已响应，执行首次短句 | 总耗时、适配器ms、是否含启动；已运行服务不能称冷启动 |
| 真正冷启动 | 在方便时手动停止专用于测试的服务后重测 | 记录从启动到完整WAV落盘，禁止擅自结束生产服务 |
| 后续合成 | 按4类语料重复测量 | P50/P95、RTF、错误次数、输出时长 |
| 默认并发预算 | 新适配器同时提交3条短句，排队15000ms | 各自总耗时、成功/超时/错误，确认没有死锁 |
| 长队列观察 | 需要时加 `--queue-timeout-ms 120000` | 只用于观察完成顺序，不能替代默认预算的失败率 |

当前 `adapterMs` 只含HTTP与落盘；`wallMs`还包含排队、探活与启动。
不能将 `wallMs - adapterMs` 全部称为排队，因为其中可能还有服务启动时间。
RTF小于1表示生成速度快于播放速度；实际可接受延迟需结合用户硬件和回复长度判断。
默认只有少量样本，P95仅供观察，需要更稳定的数据时增加 `--runs`，最大30。
报告需分别列成功样本延迟和失败率，不能通过剔除超时请求美化性能。

## 4. 与旧版做公平对照

若有完整Git仓库，可从本轮交付前的上游提交建立独立工作树：

```bash
git worktree add --detach ../dsh-tts-before 2bf711a386ec8eb6452c29b9d6217f2e30b80545
```

然后在当前仓库用同一个新测速脚本测旧适配器；明确设置 `VOICE_TTS_GSV_DIR`，
显式传入同一个参考音频与原文，避免旧版按不同目录寻找引擎。
先用单请求对照，防止把并发策略变化混入推理速度比较：

```powershell
node scripts/benchmark-tts.mjs --engine ../dsh-tts-before/packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --label before --runs 3 --concurrency 1
node scripts/benchmark-tts.mjs --engine packages/voice-out/engines/tts-core.cjs --ref-audio "$refAudio" --prompt-text-file "$refText" --label after --runs 3 --concurrency 1
```

保持相同GPU、模型、精度、参考音频、原文和服务状态，交替重复两版测试，避免其它GPU负载。
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
检查以下行为：

- 合成失败、服务不可用、参考音频缺失、排队超时：回复退回文本，不丢消息。
- 合成后变为静默、关闭开关或额度不足：不继续发语音；产物清理。
- 发送失败也清理本次合成文件；成功发送后才记语音额度。
- 普通文本概率未命中：不触发引擎；对方语音消息仍按原规则触发。
- `stop()`不结束外部服务；启动失败后可以重试，无额外遗留进程。

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
- 离线测试：PASS / FAIL / BLOCKED（附命令和错误）
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
