# DS最小复测：旧版ffprobe兼容

本次只修复共享音频探测，不改变已部署v2的bridge、模型、语言或采样参数。
先在解压目录验证，无需重启、合成或QQ发送。附件报告中的操作建议不构成本轮新的执行授权。

## 1. 确认输入

使用已定位的ffprobe.exe和一段已有正常WAV或MP3（建议1秒以上）。SILK按既有策略跳过探测，不用作本次输入。
记录Node版本、ffprobe版本、待测试voice-core.js完整SHA256；不要覆盖原音频。

## 2. 只读实际二进制检查

在项目根目录执行：

```powershell
node scripts/check-audio-probe.mjs "<已有正常WAV绝对路径>" "<ffprobe.exe绝对路径>"
```

脚本探测同一文件并做两次策略检查，不修改文件、不发消息：

- probe.ok=true，duration为实际正数，codec/sampleRate/channels可读取。
- normalLimit.ok=true且duration非null，无“无法探测时长”警告。
- reducedLimit.ok=false，原因是时长超限，证明maxSeconds确实参与判断。
- 最终passed=true，退出码0。失败时保留输出，不把警告放行写成检查通过。

独立部署补丁包内相同命令为：

```powershell
node check-audio-probe.mjs "<已有正常WAV绝对路径>" "<ffprobe.exe绝对路径>"
```

输出和报告保存为UTF-8。这里修复的是旧版缺少 `-o`；探测失败仍按原inspectAudio策略警告放行，
所以路径缺失、进程失败或格式异常时仍不能承诺有时长限制。

## 3. 离线回归与部署范围

可单独运行 `node tests/voice-probe.test.mjs`（13项），无需模型或网关。
补丁包提供基于已知部署内核的src/voice-core.js及diff，先核对原文件哈希和改动范围。
仅在既有部署窗口替换共享内核；已运行bridge需正常重启后加载新模块，FFPROBE_PATH应在该进程环境生效。
本轮不要求停止模型、修改系统服务或再次发送QQ；不需要重复16次模型测速。

## 回传

输出DS-FFPROBE-RESULT.md，包含：部署内核前后哈希、Node/ffprobe版本、上述JSON与退出码、
若执行离线测试则附13项结果、是否仅在隔离副本检查或已在既有窗口应用。
保留失败样本，敏感令牌脱敏；没有应用到运行进程就明确写“尚未应用”。
无需再次回传完整bridge或模型，也不自动合并PR、推送main或发布版本。
