import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyzeWav, summarize, summarizeTimings, markdown } from '../scripts/benchmark-tts.mjs';

function signal({ silence = false, clipped = false } = {}) {
  const rate = 32000; const frames = rate * 1.3;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 2, 40);
  if (!silence) for (let i = rate * 0.1; i < rate * 1.1; i++) {
    buf.writeInt16LE(clipped ? 32767 : Math.round(16384 * Math.sin(2 * Math.PI * 1000 * i / rate)), 44 + i * 2);
  }
  return buf;
}

test('known waveform measures duration, level and boundary silence within a window', () => {
  const a = analyzeWav(signal());
  assert.equal(a.seconds, 1.3);
  assert.equal(a.sampleRate, 32000);
  assert.ok(Math.abs(a.peakDbfs - (-6.021)) < 0.01);
  assert.ok(Math.abs(a.leadingSilenceMs - 100) <= 20);
  assert.ok(Math.abs(a.trailingSilenceMs - 200) <= 20);
  assert.equal(a.nearClippingPercent, 0);
  assert.ok(Math.abs(a.silencePercent - 100 * 0.3 / 1.3) < 0.01);
});

test('silent and saturated signals are flagged without claiming a subjective quality score', () => {
  const silent = analyzeWav(signal({ silence: true }));
  assert.equal(silent.peakDbfs, null);
  assert.equal(silent.silencePercent, 100);
  assert.ok(silent.warnings.some((w) => w.includes('静音')));
  const clipped = analyzeWav(signal({ clipped: true }));
  assert.ok(clipped.nearClippingPercent > 70);
  assert.ok(clipped.warnings.some((w) => w.includes('削波')));
});

test('truncated, compressed and empty WAV data fail analysis', () => {
  const buf = signal();
  assert.throws(() => analyzeWav(buf.subarray(0, 100)), /截断/);
  const compressed = Buffer.from(buf); compressed.writeUInt16LE(6, 20);
  assert.throws(() => analyzeWav(compressed), /不支持/);
  const empty = Buffer.from(buf.subarray(0, 44)); empty.writeUInt32LE(36, 4); empty.writeUInt32LE(0, 40);
  assert.throws(() => analyzeWav(empty), /没有音频样本/);
});

test('summary excludes failures from latency distribution while retaining failure counts', () => {
  assert.deepEqual(summarize([
    { ok: true, wallMs: 100, rtf: 0.1 }, { ok: true, wallMs: 200, rtf: 0.2 },
    { ok: false, wallMs: 5000 }
  ]), { requests: 3, succeeded: 2, failed: 1, p50Ms: 100, p95Ms: 200, meanRtf: 0.15 });
});

test('phase timing summaries retain missing data and exclude failed requests', () => {
  const result = summarizeTimings([
    { ok: true, timings: { queueMs: 100, serverMs: 5, slotMs: 50 } },
    { ok: true, timings: { queueMs: 200, serverMs: 10, slotMs: 60 } },
    { ok: false, timings: { queueMs: 9999 } }, { ok: true }
  ]);
  assert.deepEqual(result.queueMs, { samples: 2, p50: 100, p95: 200 });
  assert.deepEqual(result.serverMs, { samples: 2, p50: 5, p95: 10 });
  assert.deepEqual(result.requestMs, { samples: 0, p50: null, p95: null });
});

test('benchmark command produces playable files and a report using a fixture adapter', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-bench-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'ref.wav'), signal());
  fs.writeFileSync(path.join(tmp, 'engine.cjs'), `
const fs = require('fs'); const path = require('path'); let counter = 0;
module.exports = { DEFAULT_REF: path.join(__dirname, 'ref.wav'), referenceText: () => '参考原文', probe: async () => true, stop() {},
  async synthesize(text, options) {
    if (options.promptLang !== 'ja' || options.textLang !== 'zh') throw new Error('language options did not reach the adapter');
    const out = path.join(options.outDir, 'generated-' + (++counter) + '.wav');
    fs.copyFileSync(this.DEFAULT_REF, out); return { path: out, ms: 1 };
  }
};
`);
  const script = fileURLToPath(new URL('../scripts/benchmark-tts.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--engine', path.join(tmp, 'engine.cjs'),
    '--runs', '1', '--concurrency', '2', '--prompt-lang', 'ja', '--text-lang', 'zh',
    '--out-dir', path.join(tmp, 'results')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results'))[0]);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.status, 'completed');
  assert.equal(report.queueTimeoutMs, 90000);
  assert.equal(report.promptLang, 'ja');
  assert.equal(report.textLang, 'zh');
  assert.equal(report.rows.length, 7);
  assert.equal(report.rows.filter((r) => r.phase.startsWith('parallel-')).length, 2);
  for (const row of report.rows) assert.equal(analyzeWav(fs.readFileSync(path.join(dir, row.file))).seconds, 1.3);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('generated-')), false);
  assert.match(markdown(report), /客观波形指标不能判断可懂度/);
});

test('missing reference produces a blocked report and no simulated synthesis measurements', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-bench-blocked-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'engine.cjs'), 'module.exports = {stop() {}};');
  const script = fileURLToPath(new URL('../scripts/benchmark-tts.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--engine', path.join(tmp, 'engine.cjs'),
    '--out-dir', path.join(tmp, 'results')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const dir = path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results'))[0]);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.status, 'blocked');
  assert.equal(report.rows.length, 0);
  assert.match(report.blockedReason, /缺少参考音频/);
});

test('empty reference transcript produces a blocked report before probing or invoking the engine', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-bench-transcript-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'ref.wav'), signal());
  fs.writeFileSync(path.join(tmp, 'engine.cjs'), `
const path = require('path');
module.exports = { DEFAULT_REF: path.join(__dirname, 'ref.wav'), referenceText: () => ${JSON.stringify(' \n\t ')},
  probe() { throw new Error('probe must not run'); }, synthesize() { throw new Error('synthesis must not run'); }, stop() {} };
`);
  const script = fileURLToPath(new URL('../scripts/benchmark-tts.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--engine', path.join(tmp, 'engine.cjs'),
    '--out-dir', path.join(tmp, 'results')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const dir = path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results'))[0]);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.status, 'blocked');
  assert.equal(report.rows.length, 0);
  assert.match(report.blockedReason, /缺少参考原文.*--prompt-text-file/);
});
