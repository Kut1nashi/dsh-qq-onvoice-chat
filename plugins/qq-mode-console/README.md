# qq-mode-console

暴露 DSH `qq-mode` 设置命名空间的 host 插件（无 browser 半）。
桥接控制台切模式时写 DSH 设置，桥接进程轮询读取。

| 字段 | 取值 |
|---|---|
| `mode` | `chat` / `closed-agent` / `reserved` / `reserved2` / `simulation`，默认 `reserved2` |
| `ownerQQ` | 管理员 QQ；留空表示不通过 DSH 设置覆盖 `config.json` |

## 两个容易踩的点

1. **entry id 必须等于命名空间名**（`qq-mode`）。DSH 0.1.7 的
   `settings.write()` 用 `configEditor.entries().find(row => row.options.id === ns)` 定位目标，
   id 不一致会永远抛 `No configurable plugin entry "qq-mode"`。
2. **字段必须 `.volatile()`**，否则写入时报 `has no volatile fields`。

## 安装

```bat
npm i link:<本仓库>\plugins\qq-mode-console
:: 再把 cordis.patch.yml 里的 insert 行并入 profile
```

诊断日志默认写 `%TEMP%\qq-mode-plugin.log`，可用 `QQ_MODE_DIAG` 覆盖（空字符串 = 关闭）。
