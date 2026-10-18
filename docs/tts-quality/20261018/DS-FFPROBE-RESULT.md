# ffprobe 兼容补丁验证与应用结果

日期：2026-10-18 18:33–18:34（Asia/Shanghai）
环境：Windows，Node **v18.18.1**，ffprobe **2022-04-07-git-607ecc27ed-full_build-www.gyan.dev**（`D:\needy-voice\GPT-SoVITS-v4-20250529\ffprobe.exe`）
范围：只读兼容性检查 → 安装 `src/voice-core.js` → 重启 bridge → CLI 复测。未改 bridge.js，未改模型/采样/情绪，未发 QQ。

---

## 1. 包与哈希

| 文件 | SHA256 | 与说明对照 |
| --- | --- | --- |
| `src/voice-core.js`（修复后） | `f2392e4589cf10d0e5448304818b57bca83b4a35403264b8527348e0e8da7b93` | ✅ 与任务书一致 |
| `original-voice-core.js`（修复前） | `8bc41fb3a430e4740e6344dda609d90e6131ae120651b062386f67acf8146cf1` | ✅ 与部署版一致 |

## 2. 只读检查（旧版 ffprobe，本机实测）

命令：

```powershell
node check-audio-probe.mjs "D:/needy-voice/out/tts-1792306268998-p8og0o.wav" "D:/needy-voice/GPT-SoVITS-v4-20250529/ffprobe.exe"
```

退出码 **0**，输出（`ffprobe-compat-fix\local-check.json`）：

```json
{
  "passed": true,
  "probe": { "ok": true, "duration": 7.576438, "formatName": "wav", "codec": "pcm_s16le",
             "sampleRate": 48000, "channels": 1 },
  "normalLimit": { "ok": true, "size": 727416, "duration": 7.576438, "codec": "pcm_s16le",
                   "formatName": "wav", "sampleRate": 48000, "channels": 1, "warnings": [] },
  "reducedLimit": { "ok": false, "size": 727416, "duration": 7.576438,
                    "error": "时长 8秒 超过上限 4秒" }
}
```

三项预期全部命中：`passed=true`、`probe.ok=true` 且时长为真实正数、`normalLimit` 无“无法探测时长”警告、`reducedLimit` 因上限被拒（策略检查，未截短原音频）。

这正是上一轮失败的那一份 ffprobe：同一二进制修补前报 `Failed to set value … for option 'o': Option not found`，修补后返回 7.576 s。

离线回归：`npm test` → **13 passed / 0 failed / 0 skipped**。

## 3. 实际应用

| 项 | 值 |
| --- | --- |
| 应用前 `src/voice-core.js` | `8bc41fb3…146cf1`（21,265 B） |
| 备份 | `src/voice-core.js.bak-20261018-183353-before-ffprobe-fix` |
| 应用后 | `f2392e4589cf10d0e5448304818b57bca83b4a35403264b8527348e0e8da7b93` |
| 语法 | `node --check src/voice-core.js` 通过 |
| `src/bridge.js` | 未改动，仍是 v2 `119d506a…0e6107d` |
| 重启 | 旧 PID **28580** → 新 PID **24100**，监听 `127.0.0.1:3100` |
| 启动日志 | SnowLuma 已连接（账号 931056272），`reserved2` 模式恢复 |

只重启了 bridge；SnowLuma、GPT-SoVITS、STT 均未动。

## 4. 应用后复测（新进程加载新文件）

```powershell
node scripts/send-voice.mjs check "D:/needy-voice/out/tts-1792306268998-p8og0o.wav"
```

```
音频：D:\needy-voice\out\tts-1792306268998-p8og0o.wav
  来源：absolute
  信息：8秒 · 710.4 KB · pcm_s16le · 48.0kHz · 单声道
  容器：wav

✅ 音频可用于发送
```

对比上一轮的 `⚠️ 无法探测时长（ffprobe 不可用：spawn ffprobe ENOENT）` 与 `退出码 1`：**警告消失，时长与编码真实可读**。

## 5. 未做 / 边界

| 项 | 状态 |
| --- | --- |
| QQ 发送复测 | 未做（任务书明确不需要） |
| 模型合成 / 16 次测速 | 未做（不需要） |
| `inspectAudio` 探测失败时放行的策略 | **未改**：探测失败仍按原策略警告放行，所以只有在 ffprobe 正常时 `maxSeconds` 才生效；现在它正常了 |
| 听感 | 不涉及 |

## 6. 回滚

```powershell
cd D:\Deeeeeepseeeeek\workfile\qq-bridge-src\qq-bridge-main
copy src\voice-core.js.bak-20261018-183353-before-ffprobe-fix src\voice-core.js
node --check src\voice-core.js
# 按原方式重启 bridge（v2 的 src/bridge.js 不受影响）
```

## 7. 结论

`-o` 不兼容是旧版 ffprobe 的选项缺失，本补丁改为兼容写法后，本机 2022 构建能正常返回真实时长与编码；已应用到现网 `voice-core.js` 并重启生效，CLI 复测无警告。`bridge.js` 仍为 v2 版本，未受影响。
