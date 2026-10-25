# v2 部署与运行验证结果

日期：2026-10-18 17:37–17:49（Asia/Shanghai）
环境：Windows，Node **v18.18.1**，SnowLuma **1.14.20-node**，GPT-SoVITS v4（`D:/needy-voice`）
范围：v2 包快速核验 → 部署到现网 bridge → 获准会话 `private:2241116289` 真实发送验证。
未做：SnowLuma / GPT-SoVITS / STT 重启，模型与采样参数变更，PR 合并或推送。

---

## 1. 包核验（本机）

| 检查 | 结果 |
| --- | --- |
| `Get-FileHash generated/bridge-reviewed-v2.mjs` | `119d506a23a9f966f6461c2dc2b4ec4b6f461ad6e9a38a2443f1161cb0e6107d`，与任务书预期一致 |
| `node --check generated/bridge-reviewed-v2.mjs` | 通过 |
| `node transport-tests.mjs` | **24 passed, 0 failed** |
| `node tests/caller-tests.mjs` | **46 passed, 0 failed** |
| `python tool-encoding-fix/test-apply.py` | **7 tests OK**（本机 Python 3.14 未设 `PYTHONUTF8` 也通过，编码修复有效） |

## 2. 部署

| 项 | 值 |
| --- | --- |
| 部署前 `src/bridge.js` | `fde1b7b5d1abb104ab75baee3dfc9cb28d6c9298a38ac32c3c17df4f059c4075`（796,540 B） |
| 备份 | `src/bridge.js.bak-20261018-173706-before-v2`，哈希同上 |
| 部署后 `src/bridge.js` | `119d506a23a9f966f6461c2dc2b4ec4b6f461ad6e9a38a2443f1161cb0e6107d`（798,922 B） |
| 语法检查 | `node --check src/bridge.js` 通过（部署后复查） |
| 进程 | 旧 PID **8928** 已停；新 PID **28580**，监听 `127.0.0.1:3100` |
| 启动日志 | SnowLuma 已连接（账号 931056272）；DSH 就绪，模式 `reserved2`；本地 STT 已加载 |
| `FFPROBE_PATH` | 设为 `D:\needy-voice\GPT-SoVITS-v4-20250529\ffprobe.exe`（用户级 + 启动 shell 环境，桥进程继承） |

只重启了 bridge 一个进程。

## 3. 真实发送记录（获准会话 `private:2241116289`）

| # | 路径 | messageId | get_msg | 桥日志 | SnowLuma 日志 | 用户听感 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CLI 发已有 WAV | `910942043` | `record`，`url=D:\needy-voice\out\tts-1792306268998-p8og0o.wav` | `[voice] (操作者) 已发送语音 … 710.4 KB` | — | ✅ 语音正常；**无文本属设计**（CLI 只发语音） |
| 2 | 自动 TTS（默认情绪） | `-1495958199` | `record` | `[tts] … 情绪=常态` | — | ❌ 乱码 + 语音无意义（**作废**） |
| 3 | 自动 TTS（`[担心]`） | `1904198588` | `record` | `[tts] … 情绪=常态` | — | ❌ 乱码 + 语音无意义（**作废**） |
| 4 | 自动 TTS 重发（默认情绪） | `1189197374` | `record` | `[tts] … 情绪=常态，messageId=1189197374` | `converted record to silk … duration=4s`；`uploading 12209 bytes md5=b9e5032c…`；`ptt PUT done in 232ms`；`发送：[语音]` | ✅ 正常 |
| 5 | 自动 TTS 重发（`[担心]`） | `-1343226869` | `record` | `[tts] … 情绪=担心，messageId=-1343226869` | `17:41:00 发送：[语音]`；`发送：明天有考试吧，我有点紧张…` | ✅ 正常 |

语音条不是空音频：SnowLuma 把它转成 SILK 并上传 **12,209 字节 / 4 秒**，`ptt PUT done`。内联 base64 传输在真实网关上可用。

### 第 2、3 条的根因（已验证，与被测代码无关）

桥把收到的正文原样记录在 `state/social-v2.json`，那两条是 U+FFFD 乱码：

```
����ˤ��ϡ����ʥĤ��󡣽��դ�Ԫ�ݤǤ�����||��ã����ʥ�С�㣬����Ҳ������
[����]���դϥƥ��ȡ���͡��٤��o�����Ƥ롭||�����п��ԣ��е���š�
```

原因是我用 `curl -d '日文…'` 传非 ASCII：在 Windows 参数层就被破坏，桥收到的是坏字节。于是日语合成出无意义音频，`[担心]` 也被破坏而匹配不到。改用 Node 写 UTF-8 文件 + `curl --data-binary @file` 后，同一入口立即正常（第 4、5 条），记录文本正确、`情绪=担心` 生效。

**结论：桥、情绪解析、自动 TTS 均无缺陷；第 2、3 条是我调用方式的问题，已作废。**

## 4. 新发现缺陷：ffprobe 与 `-o` 不兼容

`voice-core.js` 的 `probeAudio()` 用 `ffprobe … -of json -o <临时文件>` 取结果。本机 ffprobe（2022-04-07 gyan full build）**没有 `-o` 选项**：

```
Failed to set value '…probe-test.json' for option 'o': Option not found
exit=1
```

后果：即使 `FFPROBE_PATH` 正确，探测也总是失败；`inspectAudio()` 在探测失败时**放行**（只加警告），因此 `socialV2.voice.maxSeconds` 目前**不生效**。这与 v2 补丁无关——v2 对 TTS 产物的时长/体积检查走自己的 WAV 头解析，已在 46 条断言中验证。

建议修法（未实施，未改现网代码）：改为 `stdio: ['ignore','pipe','ignore']` 读 stdout，或检测到 `-o` 不支持时回退 stdout。在修复前，任何"ffprobe 可用、时长已校验"的说法都不成立。

## 5. 未验证 / 边界

| 项 | 状态 |
| --- | --- |
| 发送条数 | 本轮实际 **5 条**（原定 3 条 + 2 条更正），前两条作废，已向用户说明 |
| 听感 | 仅用户口头判定（1/4/5 正常，2/3 乱码），无波形或 ASR 复核 |
| `verification` | `null`（未做 get_msg 回读的自动确认流程）；已人工核对 `record` 段 |
| 冷启动 0.32s 根因 | 未定位；v2 只做拦截 |
| 长尾性能 | 未取证；未重跑 16 次合成 |

## 6. 回滚

```powershell
cd <your-bridge-root>
copy src\bridge.js.bak-20261018-173706-before-v2 src\bridge.js   # 恢复到 fde1b7b5…c4075
node --check src\bridge.js
# 按原方式重启 bridge
```

## 7. 结论

v2 已部署并通过真实链路验证：文本发送、自动 TTS、中文译文、情绪参考、内联 base64 → SILK 转码全部走通；CLI 语音路径未回归。唯一未闭合的独立缺陷是 `probeAudio` 与现有 ffprobe 的 `-o` 不兼容。
