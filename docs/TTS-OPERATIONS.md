# TTS 启动、预热与守护部署

v5实机反馈：RTX3050Ti 4GB、CUDA模式，两次手动启动到首个HTTP响应为43.8/33.5秒；
正常启动后的首条推理为45.7秒，含惰性加载。另一次启动返回过两份0.320秒碎片后超时，根因未知。
HTTP存活、推理成功、内容质量是三个不同的检查。首个HTTP响应不能作为放行语音流量的充分条件。

## 产物防护

当前适配器检查未压缩WAV的fmt/data结构、样本帧和时长，成功返回值增加 `seconds`。
支持PCM 8/16/24/32位、浮点32/64位及相应WAVE扩展格式；空数据、截断及参数不一致会抛错。
这比按文件大小猜时长可靠，声道、采样率、位深和metadata会改变字节数。

`minAudioSeconds`默认1，仅在至少10个中日韩文字/数字，或至少10个单词时生效。
较长文本生成不足1秒时在落盘前抛“音频异常过短”，含时长、HTTP码和字节数；
自动回复沿现有错误路径发完整文本，不发送碎片。“嗯”、单个英文词等短回复不应用此下限。
`voice.tts.minAudioSeconds`或合成选项可设其它非负秒数；0仅关闭此启发式，仍检查WAV格式。

这是粗略的异常防护，不能判断漏字、静音、自然度或音色。存在误拒/漏检可能，需按真实样本校准。
规则不会自动重启服务，单个异常产物也不能证明某种启动方式导致了故障。

## 选择进程管理方式

默认 `VOICE_TTS_AUTO_START` 未设置时，适配器会在收到请求且端口无响应时启动Python，
只管理自己启动的子进程。这是按需启动，没有持续守护、后台健康监控或异常通知。
v5观察到闲置后服务停止，但退出原因未确认，不能由此认定适配器完全没有拉起能力。

使用NSSM/systemd管理Python时，在**Node桥接/测速进程**环境中设置：

```powershell
$env:VOICE_TTS_AUTO_START = 'false'
```

Linux为 `export VOICE_TTS_AUTO_START=false`。0/false/off/no（不区分大小写）均关闭按需启动。
设置需发生在模块加载前，已运行的Node进程需重启才能读取。把变量只设在Python服务中不会影响Node。
此模式下端口无响应会抛错并退回文本，不另起模型；服务恢复后下一次请求可复用。
`stop()`仍不会结束外部服务。NSSM/systemd负责崩溃后的进程恢复，推理健康需另做预热检查。

## Windows NSSM示例

以下是供本机部署的模板，云端未安装或执行。先在停机窗口确认9880的现有进程归属、退出旧实例，
替换路径并准备NSSM，再在本机管理员PowerShell运行。一个端口由一个进程管理者负责。

```powershell
$ttsBundle = '<GPT-SoVITS整合包完整路径>'
$ttsPython = Join-Path $ttsBundle 'runtime\python.exe'
$ttsApi = Join-Path $ttsBundle 'api_v2.py'
$ttsConfig = Join-Path $ttsBundle 'GPT_SoVITS\configs\tts_infer.yaml'
$ttsLogs = '<已创建的日志目录>'
Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue

nssm install DshGptSovits $ttsPython
nssm set DshGptSovits AppDirectory $ttsBundle
nssm set DshGptSovits AppParameters ('"{0}" -a 127.0.0.1 -p 9880 -c "{1}"' -f $ttsApi, $ttsConfig)
nssm set DshGptSovits AppExit Default Restart
nssm set DshGptSovits AppRestartDelay 10000
nssm set DshGptSovits AppThrottle 30000
nssm set DshGptSovits AppStdout (Join-Path $ttsLogs 'stdout.log')
nssm set DshGptSovits AppStderr (Join-Path $ttsLogs 'stderr.log')
nssm start DshGptSovits
```

服务账号必须能访问模型、参考音频和CUDA。通过 `nssm status DshGptSovits` 与日志确认进程状态，
再做下面的推理预热；“SERVICE_RUNNING”不代表模型健康。停止由 `nssm stop DshGptSovits`执行。
v5中重定向与异常同时出现不足以证明因果，保留stdout/stderr并对照启动参数、账号、CUDA与模型状态。

## Linux systemd示例

用实际CUDA可用的用户和绝对路径替换占位符，保存为 `/etc/systemd/system/dsh-gpt-sovits.service`：

```ini
[Unit]
Description=GPT-SoVITS local TTS API
After=network.target

[Service]
Type=simple
User=<实际运行用户>
WorkingDirectory=<整合包完整路径>
ExecStart=<Python完整路径> <api_v2.py完整路径> -a 127.0.0.1 -p 9880 -c <tts_infer.yaml完整路径>
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

替换后由本机操作者执行 `sudo systemctl daemon-reload`、
`sudo systemctl enable --now dsh-gpt-sovits`，通过 `journalctl -u dsh-gpt-sovits`排障。
`Type=simple`只管理进程，不声明HTTP或推理已就绪；Node桥接也须设置关闭按需启动的环境变量。

## 放行语音前执行推理预热

先启动服务并等HTTP有响应；外部守护模式下端口未响应会立即失败，不会替守护者启动Python。
默认参考音频和非空原文须就位。以下在仓库根目录执行，参考原文为日语、目标为中文：

```powershell
$env:VOICE_TTS_AUTO_START = 'false'
node -e "const t=require('./packages/voice-out/engines/tts-core.cjs'); t.warmup({text:'这是一段用于检查语音合成状态的预热文本。',promptLang:'ja',textLang:'zh',timeoutMs:120000,minAudioSeconds:1,log:console.log}).then(ok=>{console.log('inferenceWarmup=',ok);process.exitCode=ok?0:1}).finally(()=>t.stop());"
```

中文参考原文改 `promptLang:'zh'`。可通过同名合成选项传 `refAudio`、`promptText`、`outDir`等。
`warmup({text,...})`实际走一次串行合成并校验，成功清理测试WAV后返回true；
失败返回false并记录原因。不传text的旧 `warmup()`仍只探活，不代表模型完成惰性加载。

仅在推理预热成功后启动/放行正常语音回复。该预热也占合成槽，若同时接收请求，排队仍按90秒计时，
不会因为在预热而自动延长；启动300秒和HTTP120秒是其它两个独立预算。
若预热失败，先保持文本回复，保存日志和诊断样本，由明确的进程管理者处理恢复后重试。
崩溃自动重启并不自动执行这条预热命令，接入部署流程时应在每次放行前重复健康检查。

## 降级态与89秒异常的取证

记录代码哈希、模型/精度、参考材料、语言设置、进程启动方式与时间、HTTP码、
`queueMs/serverMs/requestMs/saveMs`、WAV时长/字节数，并保存同一时段的模型日志与GPU使用情况。
在模型机器可运行 `nvidia-smi --query-gpu=timestamp,name,memory.used,utilization.gpu --format=csv`做快照。
89秒单条与6秒基准同轮出现，不能直接归因显存竞争，也不应删除该异常来美化P95。
保留异常0.32秒和正常2.72秒样本，由试听/转写辅助判断；当前防护没有修复或确认服务端根因。
