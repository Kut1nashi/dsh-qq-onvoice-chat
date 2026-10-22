# TTS 音质后处理：NF43 + R4 + HF90

这是对**合成后的音频**做处理的后处理配方，不是新的模型权重，也不改变 GPT / SoVITS 的推理参数。它做两件事：

1. **全局 NF43**：`afftdn=nr=12:nf=-43:tn=0`，对未降噪的合成音频执行一次；
2. **可选 R4 局部处理**：在你明确标注的时间窗内做有上限的频谱清理，可选再叠加 HF90（6 kHz 以上分量 ×0.90）。

没有区间时只做第 1 步，并如实报告 `denoise-only`。

## 环境

- Node ≥ 18（只用内置模块）
- Python ≥ 3.9 + NumPy
- FFmpeg（需要 `afftdn` 滤镜；默认从 PATH 找，可用 `DENOISE_FFMPEG` 指定绝对路径）

```bash
pip install -r requirements.txt
```

## 用法一：处理已有 WAV

要求输入为 **48 kHz / 单声道 / PCM16**、且**没有降噪过**的合成结果。

```bash
# 1) 只做全局 NF43
python denoise.py input.wav output.wav
# 输出一行 JSON：filter / frames / lag_corrected / gain_db / anchor_difference_db / clipped / compatibility

# 2) 可选：在明确区间做 R4（区间坐标对应 output.wav）
node r4/apply.mjs --in output.wav --out output-r4.wav \
  --regions '[{"start":2.5,"end":4.5,"highFloor":0.94},{"start":7.5,"end":9.5,"highFloor":1.0,"hf90":true}]'
```

`apply.mjs` 会打印 JSON：窗内改动样点数、`outside_changed`（必须为 0）、`hf90_ranges`、锚定增益等。

区间 JSON 也可写成文件后用 `--regions-file`：

```json
[
  { "start": 2.5, "end": 4.5, "highFloor": 0.94, "hf90": false },
  { "start": 7.5, "end": 9.5, "highFloor": 1.0, "hf90": true }
]
```

`highFloor` 是该区间高频增益下限（默认 1.0，即不做额外高频衰减），`hf90: true` 才会叠加 6 kHz 以上的 ×0.90。

## 用法二：接进自己的 TTS 工程

```js
const { denoiseInPlace } = require('./postprocess.cjs');

const result = await denoiseInPlace(wavPath, { timeoutMs: 120000 });
if (!result.applied) {
  // 保留原文件，按你自己的策略回退或记录原因
  console.warn('denoise skipped:', result.reason);
}
```

顺序固定为：

```
TTS 合成 → 尾部裁剪/补白 → 全局 NF43（一次） → 可选 R4/HF90 → 音量/响度 → 编码与发送
```

**不要**对已经降噪的结果再跑一次全局 NF43，也不要在有损编码之后再解码降噪。

## 参数

完整参数见 [`presets/nf43-r4-hf90-rep-final.json`](presets/nf43-r4-hf90-rep-final.json)。要点：

| 阶段 | 关键参数 |
| --- | --- |
| NF43 | `nr=12`、`nf=-43`、`tn=0`；额外 4800 样点 EOF 保护；参考区间 20 ms RMS > −35 dBFS；全局电平修正 ≤1 dB |
| R4 | FFT 2048 / hop 512 / Hann；局部非静音帧第 15 百分位代理；Wiener 0.6；5 bin 频率 + 3 帧时间平滑；≤160 Hz 保留；400–4500 Hz 弱频点 ≥0.90；每窗电平修正 ≤0.30 dB；40 ms 窗内过渡 |
| HF90 | 居中 129 tap、6 kHz FIR；高频分量系数 0.90；仅指定区间 |

`0.90` 是**幅度系数**，对应高频能量约 −19%，不等于“气声减少 10%”，也会影响部分辅音与齿音。

## 已知限制

- **区间必须由调用方提供**，本项目没有自动识别重音/气声的算法；没有区间就不要生成区间。
- 本配方验证的是“某一句的最终听感”和一整套实现方案，**不能保证换一句话只套全局参数就得到同样效果**。
- 参数是后处理，不改善模型训练本身；用在训练语料上属于另一种分布，需要单独评估。
- RMS 匹配不是感知响度归一；频段能量下降不等于真实 SNR 提升。

## 测试

```bash
python tests/quality/test_denoise.py      # 需要 NumPy，不需要 FFmpeg
node --test tests/quality/*.test.cjs      # 纯生成信号，不需要私有音频
```

公共测试各自生成测试信号，不依赖任何角色音频或素材。
