# 贡献指南

## 环境

- Node.js ≥ 18
- 只跑纯函数测试不需要任何引擎：`npm test`
- 端到端验证需要 GPT-SoVITS 整合包与 SenseVoice 模型（见 [docs/ENV-SETUP.md](docs/ENV-SETUP.md)）

## 提交前

```bash
npm run check   # 可执行文件的语法检查
npm test        # 冒烟测试（离线）
```

## 硬性约定

1. **不提交模型、二进制、`node_modules`、音频内容**。仓库只放源码与文档。
2. **不写死绝对路径**。引擎路径一律「环境变量 → 配置文件 → 相对位置」。
3. **不复制实现**。音频内核只有 `voice-core.js` 一份，其它入口 `require`/`import` 它。
4. **不吞掉降级语义**。TTS/STT 任何失败都必须退回文本或 `[语音]`，不能让回复消失。
5. **不放松语音库边界**。放宽 `resolveVoicePathForV2` 前请先在 issue 里讨论威胁模型。
6. **保留 `verified` 校验**。删除回读校验会让 AI 谎报"已发语音"。

## 提交信息

Conventional Commits 风格：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`。
