# qq-agent-presets

`qq-bridge` 的 DSH agent preset bundle：把 `qq-chat` / `qq-chat-v2` 两条人格作为
`@deepseek-ai/dsh-agent-preset` 行插入 profile，并携带两个 preset 共用的安全守卫。

| 文件 | 作用 |
|---|---|
| `presets/qq-chat.patch.yml` | 一代聊天人格（文本自动转发那套节奏） |
| `presets/qq-chat-v2.patch.yml` | 二代仿真：AI 自主决定看/回/潜水，工具驱动 |
| `qq-tool-restrict.mjs` | **唯一权威实现**：注册期隐藏本地执行/文件工具，执行期白名单兜底 |

## 安装

```bat
:: 1) 以 link: 依赖装进 profile 的 node_modules（不要复制，避免两份实现漂移）
npm i link:<本仓库>\plugins\qq-agent-presets

:: 2) 把 patch 行加入 profile 的 loader 配置（或由 dsh 的 bundle patch 机制加载）
```

DSH **0.1.7+** 的 preset 是 loader 行，子行 `name` 按 profile 目录解析，所以守卫用
裸说明符 `qq-agent-presets/qq-tool-restrict.mjs`。仓库搬家后重建 link 即可，**不需要改任何绝对路径**。

> 人格正文与工具面在 `presets/*.patch.yml` 里，改动前请读文件顶部注释：
> patch 由 `scripts/build-agent-preset-patches.mjs` 生成，手改会在下次生成时被覆盖。
