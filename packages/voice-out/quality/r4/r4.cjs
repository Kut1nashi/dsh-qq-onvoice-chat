// 只接收明确区间；worker 失败保留上一步 WAV。冻结 DSP 算法不在此修改。
'use strict';
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = path.join(__dirname, 'apply.mjs');
const TIMEOUT_MS = 30000;

function wavFrames(p) {
  const b = fs.readFileSync(p);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a PCM WAV');
  }
  if (b.readUInt32LE(4) + 8 !== b.length) throw new Error('WAV length mismatch');
  let format = false, frames = null, i = 12;
  while (i + 8 <= b.length) {
    const tag = b.toString('ascii', i, i + 4), size = b.readUInt32LE(i + 4), begin = i + 8;
    if (begin + size > b.length) throw new Error('Truncated WAV chunk');
    if (tag === 'fmt ') {
      if (format || size < 16 || b.readUInt16LE(begin) !== 1 || b.readUInt16LE(begin + 2) !== 1
          || b.readUInt32LE(begin + 4) !== 48000 || b.readUInt16LE(begin + 12) !== 2
          || b.readUInt16LE(begin + 14) !== 16 || b.readUInt32LE(begin + 8) !== 96000) {
        throw new Error('Expected 48kHz mono PCM16');
      }
      format = true;
    }
    if (tag === 'data') {
      if (frames !== null || size === 0 || size % 2) throw new Error('Invalid PCM data');
      frames = size / 2;
    }
    i = begin + size + (size % 2);
  }
  if (i !== b.length || !format || frames === null) throw new Error('Missing or incomplete WAV format/data');
  return frames;
}

function applyR4(wavPath, regions, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let frames;
    try { frames = wavFrames(wavPath); }
    catch { return resolve({ applied: false, ms: 0, reason: 'missing-or-invalid-input' }); }
    if (!Array.isArray(regions) || regions.length === 0) {
      return resolve({ applied: false, ms: 0, reason: 'no-regions' });
    }
    const tmp = path.join(path.dirname(wavPath), `.r4-${process.pid}-${randomUUID()}.wav`);
    const fail = (reason) => {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      resolve({ applied: false, ms: Date.now() - t0, reason: String(reason).slice(0, 300) });
    };
    try {
      const child = execFile(process.execPath,
        [WORKER, '--in', wavPath, '--out', tmp, '--regions', JSON.stringify(regions)],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) return fail(String(stderr || error.message).trim());
          try {
            // Split actual line endings, never the two characters backslash+n in Windows JSON paths.
            const lines = String(stdout).trim().split(/\r?\n/);
            const stats = JSON.parse(lines[lines.length - 1]);
            if (!stats || stats.ok !== true || stats.frames !== frames || stats.outside_changed !== 0
                || typeof stats.input !== 'string' || typeof stats.output !== 'string'
                || path.resolve(stats.input) !== path.resolve(wavPath)
                || path.resolve(stats.output) !== path.resolve(tmp)) throw new Error('Invalid worker statistics');
            if (wavFrames(tmp) !== frames) throw new Error('Worker WAV frame count changed');
            fs.renameSync(tmp, wavPath);
            resolve({ applied: true, ms: Date.now() - t0, stats });
          } catch (e) { fail(`bad-worker-output: ${e.message || e}`); }
        });
      child.unref?.();
    } catch (e) { fail(`worker-start-failed: ${e.message || e}`); }
  });
}

module.exports = { applyR4, WORKER };
