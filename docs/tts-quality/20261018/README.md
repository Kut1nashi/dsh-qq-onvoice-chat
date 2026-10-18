# TTS 音质对照材料（2026-10-18）

本目录是 [TTS-OPTIMIZATION-SUMMARY.md](TTS-OPTIMIZATION-SUMMARY.md) 阶段 1 的首批对照材料，以及此前两轮部署验证报告。

## 内容

| 文件 | 说明 |
| --- | --- |
| `TTS-OPTIMIZATION-SUMMARY.md` | 音质与自然度优化执行计划（原始文档，未改动） |
| `DS-DEPLOY-V2-RESULT.md` | v2 bridge 部署与真实发送验证结果 |
| `DS-FFPROBE-RESULT.md` | 旧版 ffprobe `-o` 兼容补丁的验证与应用结果 |
| `audio/S{1..4}_R{0,1,2}.wav` | 4 句日语 × 3 组参考，共 12 条 |
| `cases.json` | 固定语料原文 |
| `references.json` | 三组参考的路径 |
| `run-order.json` | 实际执行顺序（按句轮换，避免固定先跑 R0） |
| `results.json` | 每条耗时、字节数、输出路径 |
| `SHA256SUMS.txt` | 12 条 WAV 的 SHA256 |

## 参考

| ID | 文件 | 时长 | SHA256 前缀 |
| --- | --- | --- | --- |
| R0 | `D:/needy-voice/ref/sally_ref.wav` | 6.38 s | `b131d823…` |
| R1 | `D:/needy-voice/ref/a12_ref.wav` | 6.62 s | `f0bcabaf…` |
| R2 | `D:/needy-voice/ref/sally_ref_a06.wav` | 8.35 s | `cbe97e4f…` |

三组参考互不相同。`ref/emo/neutral.wav` 与 `sally_ref.wav` 字节完全相同，已排除，未用于对照。

## 生成条件

- 适配器：`D:/needy-voice/tts-core.cjs`（GPT-SoVITS v4，本机 RTX 3050 Ti 4 GB）
- 固定参数：`textLang=ja`、`promptLang=ja`、`seed=123`，其余取适配器默认值（speed 0.88、sample_steps 32、temperature 0.8、top_k 5、top_p 1、repetition_penalty 1.35、fragment_interval 0.4、split cut2）
- 唯一实验变量：参考音频及其对应逐字原文
- Node v18.18.1；未改生产文件、未重启服务、未发 QQ

## 听感

**未评分。** 12 条仅用于人工盲听比较；`listening.csv` 未填写，音质结论待人工试听确认。客观记录（耗时、字节数）见 `results.json`。
