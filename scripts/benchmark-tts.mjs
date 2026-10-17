// 在实际 GPT-SoVITS 机器上运行；不调用 QQ 网关，不把模拟数据当成合成成绩。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
export const CASES = [
  { id: 'short', text: '你好，今天过得怎么样？', listenFor: '首尾是否完整、语气是否自然' },
  { id: 'medium', text: '今天下午三点半，我们在图书馆门口见面。如果下雨，就改到一楼大厅，记得带上你的笔记本。', listenFor: '数字读法、逗号停顿、句尾是否截断' },
  { id: 'long', text: '最近我发现，把一件复杂的事情拆成几个小步骤，做起来会轻松很多。先确定最重要的目标，再给每一步留出足够的时间。遇到不确定的地方，可以先记录下来，等掌握更多信息后再调整。这样既能保持进度，也不会因为反复纠结而打乱节奏。', listenFor: '长句是否漏字、复读、音色漂移或出现异常长停顿' },
  { id: 'mixed', text: '明天是2026年10月18日，预算是128.50元。请打开GitHub，检查TTS接口，再回复一句：测试完成。', listenFor: '日期、金额、英文缩写及中英切换' }
];

function dbfs(amplitude) { return amplitude > 0 ? 20 * Math.log10(amplitude) : null; }
const rounded = (n) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

/** 常见未压缩 WAV 的客观检查；静音按 20ms 窗 RMS < -45dBFS 估计。不能评价自然度。 */
export function analyzeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('无效 WAV 文件头');
  }
  let fmt = null; let data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const start = at + 8;
    if (size > buf.length - start) throw new Error(`WAV ${id} 块被截断`);
    if (id === 'fmt ' && size >= 16) {
      let format = buf.readUInt16LE(start);
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(start + 24);
      fmt = { format, channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4),
        blockAlign: buf.readUInt16LE(start + 12), bits: buf.readUInt16LE(start + 14) };
    }
    if (id === 'data' && data === null) data = buf.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate || !fmt.blockAlign) throw new Error('WAV 缺少有效格式或音频数据');
  const { format, channels, sampleRate, blockAlign, bits } = fmt;
  const bytesPerSample = bits / 8;
  if (blockAlign !== channels * bytesPerSample || data.length % blockAlign) throw new Error('WAV 样本帧不完整');
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && [32, 64].includes(bits))) {
    throw new Error(`不支持的 WAV 编码 ${format}/${bits}bit`);
  }
  const frames = data.length / blockAlign;
  if (!frames) throw new Error('WAV 没有音频样本');
  const read = (at) => {
    if (format === 3) return bits === 32 ? data.readFloatLE(at) : data.readDoubleLE(at);
    if (bits === 8) return (data[at] - 128) / 128;
    return data.readIntLE(at, bytesPerSample) / (2 ** (bits - 1));
  };
  const window = Math.max(1, Math.round(sampleRate * 0.02));
  const silentWindows = [];
  let peak = 0; let squareSum = 0; let clipped = 0; let dc = 0;
  let windowSum = 0; let windowFrames = 0; let silentFrames = 0;
  for (let frame = 0; frame < frames; frame++) {
    let frameSum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const value = read(frame * blockAlign + ch * bytesPerSample);
      if (!Number.isFinite(value)) throw new Error('WAV 包含非有限数值');
      peak = Math.max(peak, Math.abs(value));
      squareSum += value * value; frameSum += value * value; dc += value;
      if (Math.abs(value) >= 0.999) clipped += 1;
    }
    windowSum += frameSum; windowFrames += 1;
    if (windowFrames === window || frame === frames - 1) {
      const silent = Math.sqrt(windowSum / (windowFrames * channels)) < 10 ** (-45 / 20);
      silentWindows.push({ silent, frames: windowFrames });
      if (silent) silentFrames += windowFrames;
      windowSum = 0; windowFrames = 0;
    }
  }
  let leading = 0; let trailing = 0; let longest = 0; let run = 0;
  for (const w of silentWindows) { run = w.silent ? run + w.frames : 0; longest = Math.max(longest, run); }
  for (const w of silentWindows) { if (!w.silent) break; leading += w.frames; }
  for (const w of [...silentWindows].reverse()) { if (!w.silent) break; trailing += w.frames; }
  const warnings = [];
  if (peak < 10 ** (-45 / 20)) warnings.push('全段电平接近静音');
  if (clipped / (frames * channels) > 0.001) warnings.push('接近满幅样本占比超过0.1%，需检查削波');
  if (longest / sampleRate > 1) warnings.push('存在超过1秒的低电平区间，需试听确认停顿');
  return { ...fmt, frames, seconds: rounded(frames / sampleRate), peakDbfs: rounded(dbfs(peak)),
    rmsDbfs: rounded(dbfs(Math.sqrt(squareSum / (frames * channels)))), dcOffset: rounded(dc / (frames * channels)),
    nearClippingPercent: rounded(100 * clipped / (frames * channels)),
    silencePercent: rounded(100 * silentFrames / frames), leadingSilenceMs: rounded(1000 * leading / sampleRate),
    trailingSilenceMs: rounded(1000 * trailing / sampleRate), longestSilenceMs: rounded(1000 * longest / sampleRate), warnings };
}

export function summarize(rows) {
  const times = rows.filter((r) => r.ok).map((r) => r.wallMs).sort((a, b) => a - b);
  const quantile = (p) => times.length ? rounded(times[Math.max(0, Math.ceil(times.length * p) - 1)]) : null;
  const rtf = rows.filter((r) => r.ok && Number.isFinite(r.rtf)).map((r) => r.rtf);
  return { requests: rows.length, succeeded: times.length, failed: rows.length - times.length,
    p50Ms: quantile(0.5), p95Ms: quantile(0.95),
    meanRtf: rtf.length ? rounded(rtf.reduce((a, b) => a + b, 0) / rtf.length) : null };
}

export function summarizeTimings(rows) {
  const summary = {};
  for (const key of ['queueMs', 'serverMs', 'requestMs', 'saveMs', 'slotMs']) {
    const values = rows.filter((r) => r.ok && Number.isFinite(r.timings?.[key])).map((r) => r.timings[key]).sort((a, b) => a - b);
    summary[key] = { samples: values.length, p50: values.length ? rounded(values[Math.ceil(values.length * 0.5) - 1]) : null,
      p95: values.length ? rounded(values[Math.ceil(values.length * 0.95) - 1]) : null };
  }
  return summary;
}

function parseArgs(args) {
  const opts = { runs: 3, concurrency: 3, queueTimeoutMs: 15000, label: 'default', outDir: 'tts-benchmark-results',
    engine: fileURLToPath(new URL('../packages/voice-out/engines/tts-core.cjs', import.meta.url)) };
  const keys = { '--engine': 'engine', '--runs': 'runs', '--concurrency': 'concurrency', '--label': 'label',
    '--out-dir': 'outDir', '--ref-audio': 'refAudio', '--prompt-text-file': 'promptTextFile', '--queue-timeout-ms': 'queueTimeoutMs' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    if (!keys[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数错误：${args[i]}`);
    opts[keys[args[i]]] = args[++i];
  }
  for (const key of ['runs', 'concurrency']) {
    opts[key] = Number(opts[key]);
    if (!Number.isInteger(opts[key]) || opts[key] < 1 || opts[key] > (key === 'runs' ? 30 : 9)) throw new Error(`${key} 超出范围`);
  }
  opts.queueTimeoutMs = Number(opts.queueTimeoutMs);
  if (!Number.isInteger(opts.queueTimeoutMs) || opts.queueTimeoutMs < 1 || opts.queueTimeoutMs > 2147483647) throw new Error('queueTimeoutMs 超出范围');
  return opts;
}

export function markdown(report) {
  const lines = ['# TTS 本机测速报告', '', `生成时间：${report.createdAt}；标签：${report.label}；状态：${report.status}`, '',
    '测量范围：适配器调用到完整 WAV 落盘，包含排队/启动；不含 QQ 转码、发送或收听延迟。',
    '首次调用不等于冷启动：服务此前可能已运行。P95 采用最近秩法，少量样本只能用于观察。', ''];
  lines.push(`排队超时：${report.queueTimeoutMs}ms（默认与自动回复的15000ms一致）。`, '');
  if (report.blockedReason) lines.push(`未完成真实合成：${report.blockedReason}`, '');
  if (report.reference) {
    lines.push(`参考原文已提供：${report.reference.promptTextPresent}；参考音频时长：${report.reference.audio?.seconds ?? '无法分析'}秒。`, '');
    if (report.reference.error) lines.push(`参考音频检查：${report.reference.error}`, '');
    for (const warning of report.reference.warnings) lines.push(`参考音频提示：${warning}`, '');
  }
  if (report.serviceAlreadyRunning !== undefined) lines.push(`测试前服务已响应：${report.serviceAlreadyRunning}`, '');
  if (report.rows.length) {
    lines.push('| 阶段/文本 | 成功 | 总耗时 ms | 适配器 ms | 音频秒 | 总耗时 RTF | 峰值 dBFS | 静音 % |',
      '|---|---|---|---|---|---|---|---|');
    for (const r of report.rows) lines.push(`| ${r.phase}/${r.caseId} | ${r.ok} | ${r.wallMs} | ${r.adapterMs ?? '-'} | ${r.audio?.seconds ?? '-'} | ${r.rtf ?? '-'} | ${r.audio?.peakDbfs ?? '-'} | ${r.audio?.silencePercent ?? '-'} |`);
    lines.push('', 'RTF = 总耗时 / 音频时长；小于 1 表示生成速度快于音频播放速度。', '', '## 分组统计', '',
      '| 分组 | 成功/请求 | P50 ms | P95 ms | 平均总耗时 RTF |', '|---|---|---|---|---|');
    for (const [key, s] of Object.entries(report.summary)) lines.push(`| ${key} | ${s.succeeded}/${s.requests} | ${s.p50Ms ?? '-'} | ${s.p95Ms ?? '-'} | ${s.meanRtf ?? '-'} |`);
    lines.push('', '## 分阶段计时', '', '阶段均为毫秒。requestMs包含HTTP传输和响应读取；serverMs包含探活/启动，不能当成排队。旧适配器不提供timings时保留空值。', '',
      '| 阶段/文本 | 排队 | 探活/启动 | HTTP请求 | 落盘 | 合成槽占用 |', '|---|---|---|---|---|---|');
    for (const r of report.rows) lines.push(`| ${r.phase}/${r.caseId} | ${r.timings?.queueMs ?? '-'} | ${r.timings?.serverMs ?? '-'} | ${r.timings?.requestMs ?? '-'} | ${r.timings?.saveMs ?? '-'} | ${r.timings?.slotMs ?? '-'} |`);
    lines.push('', '后续请求的排队预算需按本机合成槽占用P95及并发数评估。例如三请求串行时，最后一条可能等待前两条完成。',
      '15秒是默认响应预算，并非CPU/GPU通用性能保证。30–45秒只作为待实测的候选，不能在没有数据时自动调高。超时失败仍计入失败率。', '');
    lines.push('', '## 试听清单', '', '客观波形指标不能判断可懂度、自然度、音色相似度或漏字；以下项目需要逐段试听。', '');
    for (const c of CASES) {
      lines.push(`- ${c.id}：${c.text}`, `  - 关注：${c.listenFor}`);
      for (const r of report.rows.filter((r) => r.ok && r.caseId === c.id)) lines.push(`  - [${r.phase} ${r.file}](${r.file})${r.audio.warnings.length ? `；提示：${r.audio.warnings.join('；')}` : ''}`);
    }
    for (const r of report.rows.filter((r) => !r.ok)) lines.push('', `失败 ${r.phase}/${r.caseId}：${r.error}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/benchmark-tts.mjs [--engine tts-core.cjs] [--runs 3] [--concurrency 3] [--queue-timeout-ms 15000] [--label default] [--out-dir directory] [--ref-audio reference.wav] [--prompt-text-file reference.txt]');
    return;
  }
  const outDir = path.resolve(opts.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  // 每次运行使用独立目录，旧报告和试听产物不会被覆盖。
  const runDir = fs.mkdtempSync(path.join(outDir, 'run-'));
  const report = { createdAt: new Date().toISOString(), label: opts.label, status: 'blocked',
    runtime: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length },
    runs: opts.runs, concurrency: opts.concurrency, queueTimeoutMs: opts.queueTimeoutMs, rows: [], summary: {} };
  let engine;
  try {
    engine = require(path.resolve(opts.engine));
    const refAudio = opts.refAudio ? path.resolve(opts.refAudio) : engine.DEFAULT_REF;
    if (!refAudio || !fs.existsSync(refAudio)) throw new Error(`缺少参考音频：${refAudio || '请用 --ref-audio 指定'}`);
    const promptText = opts.promptTextFile ? fs.readFileSync(opts.promptTextFile, 'utf8').trim() : undefined;
    report.reference = { promptTextPresent: Boolean((promptText ?? engine.referenceText?.() ?? '').trim()), warnings: [] };
    try {
      report.reference.audio = analyzeWav(fs.readFileSync(refAudio));
      report.reference.warnings.push(...report.reference.audio.warnings);
      if (report.reference.audio.seconds < 3 || report.reference.audio.seconds > 10) {
        report.reference.warnings.push('参考片段不在建议的3~10秒范围内');
      }
    } catch (error) { report.reference.error = String(error.message); }
    if (!report.reference.promptTextPresent) report.reference.warnings.push('未提供参考原文，音色稳定性需重点试听');
    report.serviceAlreadyRunning = typeof engine.probe === 'function' ? await engine.probe(2500) : undefined;
    const options = { refAudio, ...(promptText !== undefined ? { promptText } : {}),
      outDir: runDir, queueTimeoutMs: opts.queueTimeoutMs, log: (m) => console.log(String(m)) };
    const run = async (phase, c) => {
      console.log(`[${phase}/${c.id}] 合成 ${[...c.text].length} 字符…`);
      const t0 = performance.now();
      let produced;
      const row = { phase, caseId: c.id, text: c.text, chars: [...c.text].length, ok: false };
      try {
        produced = await engine.synthesize(c.text, options);
        row.wallMs = rounded(performance.now() - t0);
        row.adapterMs = produced.ms ?? null;
        if (produced.timings) row.timings = produced.timings;
        // 旧/外部适配器可能忽略 outDir，复制进报告目录，避免清理其缓存或原始文件。
        const destination = path.join(runDir, `${phase}-${c.id}.wav`);
        fs.copyFileSync(produced.path, destination);
        row.file = path.basename(destination);
        const bytes = fs.readFileSync(destination);
        row.bytes = bytes.length; row.audio = analyzeWav(bytes);
        row.rtf = rounded(row.wallMs / (row.audio.frames / row.audio.sampleRate * 1000));
        row.ok = true;
      } catch (error) {
        row.wallMs ??= rounded(performance.now() - t0);
        row.error = String(error?.message ?? error);
      } finally {
        if (produced?.path && path.dirname(path.resolve(produced.path)) === runDir) {
          try { fs.unlinkSync(produced.path); } catch {}
        }
      }
      report.rows.push(row);
      console.log(`  ${row.ok ? 'OK' : 'FAIL'} ${row.wallMs}ms${row.rtf !== undefined ? ` RTF=${row.rtf}` : ''}`);
      return row;
    };
    const first = await run('first', CASES[0]);
    if (!first.ok) throw new Error(first.error);
    // 轮换语料顺序，减少总是先测同一文本带来的偏差。
    for (let i = 0; i < opts.runs; i++) {
      for (let j = 0; j < CASES.length; j++) await run(`warm-${i + 1}`, CASES[(i + j) % CASES.length]);
    }
    await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => run(`parallel-${i + 1}`, CASES[0])));
    report.status = report.rows.every((r) => r.ok) ? 'completed' : 'partial';
  } catch (error) {
    report.blockedReason = String(error?.message ?? error);
    console.error(report.blockedReason);
  } finally {
    engine?.stop?.();
    for (const c of CASES) report.summary[`warm/${c.id}`] = summarize(report.rows.filter((r) => r.phase.startsWith('warm-') && r.caseId === c.id));
    report.summary.parallel = summarize(report.rows.filter((r) => r.phase.startsWith('parallel-')));
    report.timingSummary = {
      warm: summarizeTimings(report.rows.filter((r) => r.phase.startsWith('warm-'))),
      parallel: summarizeTimings(report.rows.filter((r) => r.phase.startsWith('parallel-')))
    };
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(runDir, 'report.md'), markdown(report));
    console.log(`报告：${path.join(runDir, 'report.md')}`);
    if (report.status !== 'completed') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
