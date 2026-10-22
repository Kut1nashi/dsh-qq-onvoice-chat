'use strict';
// 语音后处理包装层：先验证 Python 结果，再替换原文件；失败保持输入不变。
// 这是 NF43 + 可选 R4 的接线示例，不含任何项目私有路径或素材。
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const DEFAULT_TIMEOUT = 120000;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inspectWav(file) {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'not a RIFF/WAVE file' };
  }
  let fmt = null, data = null, cursor = 12;
  while (cursor + 8 <= b.length) {
    const tag = b.toString('ascii', cursor, cursor + 4);
    const size = b.readUInt32LE(cursor + 4);
    if (tag === 'fmt ') fmt = b.subarray(cursor + 8, cursor + 8 + size);
    if (tag === 'data') data = b.subarray(cursor + 8, cursor + 8 + size);
    cursor += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { ok: false, reason: 'missing fmt/data chunk' };
  const rate = fmt.readUInt32LE(4), channels = fmt.readUInt16LE(2), bits = fmt.readUInt16LE(14);
  if (rate !== 48000 || channels !== 1 || bits !== 16) {
    return { ok: false, reason: `expect 48kHz/mono/16-bit, got ${rate}Hz/${channels}ch/${bits}bit` };
  }
  return { ok: true, frames: data.length / 2, bytes: b.length };
}

function runPython(args, { timeoutMs }) {
  const python = process.env.TTS_QUALITY_PYTHON || process.env.PYTHON || 'python';
  return new Promise((resolve, reject) => {
    execFile(python, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`denoise failed: ${String(stderr || error.message).trim().slice(0, 400)}`));
        resolve(stdout);
      });
  });
}

/**
 * 对单个 WAV 做一次全局 NF43。调用方必须保证输入是未处理过的合成结果。
 * @param {string} wavPath 48kHz/mono/16-bit WAV
 * @param {{timeoutMs?: number, python?: string}} [options]
 */
async function denoiseInPlace(wavPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;
  const info = inspectWav(wavPath);
  if (!info.ok) return { applied: false, reason: info.reason };
  if (info.frames > 48000 * 60) return { applied: false, reason: 'audio longer than 60s' };

  const before = sha256(wavPath);
  const tmp = `${wavPath}.nf43-${process.pid}-${Date.now()}.wav`;
  let parsed;
  try {
    const stdout = await runPython([path.join(HERE, 'denoise.py'), wavPath, tmp], { timeoutMs });
    parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const unchanged = fs.existsSync(wavPath) && sha256(wavPath) === before;
    return { applied: false, reason: `${error.message}${unchanged ? '' : '; input changed unexpectedly'}` };
  }

  const out = inspectWav(tmp);
  const problems = [];
  if (!out.ok) problems.push(out.reason);
  if (parsed.filter !== 'afftdn=nr=12:nf=-43:tn=0') problems.push(`unexpected filter ${parsed.filter}`);
  if (out.ok && info.frames !== out.frames) problems.push(`frame count ${out.frames} != ${info.frames}`);
  if (parsed.clipped) problems.push('clipped output');
  if (problems.length) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { applied: false, reason: problems.join('; ') };
  }

  fs.renameSync(tmp, wavPath);
  return { applied: true, ms: 0, stats: parsed };
}

module.exports = { denoiseInPlace, inspectWav };
