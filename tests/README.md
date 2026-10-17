# 测试

## 离线冒烟（CI 跑这个）

```bash
npm test          # node tests/smoke.mjs
npm run check     # node scripts/check-syntax.mjs
```

`smoke.mjs` 只依赖 Node 内置模块，验证语音内核的纯函数：来源解析、库内边界、
体积/时长格式化、目标 key、音量档位、文件名净化。

## 桥接内集成测试

`bridge/` 下 5 个脚本原本位于 `qq-bridge-main/scripts/`，**依赖桥接仓库结构**
（会 import `../src/bridge.js` 并断言路由/守卫实现存在），所以不随本仓库的 CI 跑。

用法：把它们复制回你的 `qq-bridge-main/scripts/`，并让 `src/` 下存在
`voice-core.js` / `send-voice-lib.js` 后执行：

```bash
node scripts/test-voice.mjs          # 主链路
node scripts/test-voice-edge.mjs     # 边界：空文件 / 超时 / 超限 / 库外路径
node scripts/test-voice-volume.mjs   # 音量与 loudness
node scripts/test-voice-preview.mjs  # 预览
node scripts/test-voice-system.mjs   # 系统级
```

> 默认**不真发语音**（真发会产生不可撤回的 QQ 消息）。要真发用 CLI：
> `node scripts/send-voice.mjs check <音频>` 先探测，再 `send`。
