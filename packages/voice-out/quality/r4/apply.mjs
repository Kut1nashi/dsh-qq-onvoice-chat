// R4 局部处理 worker（ESM）：只做纯 PCM 处理，读写单文件，不碰网络、模型、FFmpeg。
// 用法：
//   node apply.mjs --in a.wav --out b.wav --regions "<json>" | --regions-file x.json
// regions: [{ "start": 2.5, "end": 4.5, "highFloor": 0.94, "hf90": false }, ...]（秒）
import fs from 'node:fs';
import { decodeWav, encodeWav } from './wav-utils.mjs';
import { localSpectralCleanup } from './nf43-r4.mjs';
import { applyLocalMask } from './nf43-local-mask.mjs';

const RATE = 48000;
const need = (ok, message) => { if (!ok) throw new Error(message); };

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    need(typeof name === 'string' && name.startsWith('--') && argv[i + 1] !== undefined, `Invalid option ${name}`);
    out[name.slice(2)] = argv[i + 1];
  }
  return out;
}

export function run({ input, output, regions }) {
  const samples = decodeWav(fs.readFileSync(input));
  const duration = samples.length / RATE;
  need(Array.isArray(regions) && regions.length > 0, 'regions must be a non-empty array');
  need(regions.length <= 12, 'At most 12 regions');
  const normalized = regions.map((r) => {
    need(Number.isFinite(r.start) && Number.isFinite(r.end), 'Invalid region time');
    need(r.start >= 0 && r.end > r.start && r.end <= duration, `Region ${r.start}-${r.end} outside ${duration.toFixed(3)}s`);
    need(r.end - r.start >= 0.12, 'Region must be at least 120ms');
    return {
      start: r.start,
      end: r.end,
      highFloor: Number.isFinite(r.highFloor) ? r.highFloor : 1.0,
      hf90: r.hf90 === true,
    };
  });
  normalized.sort((a, b) => a.start - b.start);
  for (let i = 1; i < normalized.length; i++) need(normalized[i].start >= normalized[i - 1].end, 'Regions overlap');

  const cleaned = localSpectralCleanup(samples, normalized.map(({ start, end, highFloor }) => ({ start, end, highFloor })));
  const ranges = normalized.filter((r) => r.hf90).map((r) => ({
    start: Math.round(r.start * RATE), end: Math.round(r.end * RATE),
  }));
  const final = ranges.length ? applyLocalMask(cleaned.samples, ranges).samples : cleaned.samples;

  let changed = 0, outside = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] !== final[i]) {
      changed++;
      if (!normalized.some((r) => i >= Math.round(r.start * RATE) && i < Math.round(r.end * RATE))) outside++;
    }
    peak = Math.max(peak, Math.abs(final[i]));
  }
  need(outside === 0, `Change outside regions: ${outside} samples`);
  need(final.length === samples.length, 'Length changed');

  const bytes = encodeWav(final);
  const tmp = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, output);
  return {
    ok: true, input, output, frames: samples.length, seconds: duration,
    regions: normalized, changed_samples: changed, outside_changed: outside,
    hf90_ranges: ranges.length, proxy_frames: cleaned.proxyFrames,
    anchor_logs: cleaned.logs, peak_dbfs: 20 * Math.log10(peak || 1e-12),
    bytes: bytes.length,
  };
}

if (process.argv[1] && process.argv[1].endsWith('apply.mjs')) {
  try {
    const args = options(process.argv.slice(2));
    need(args.in && args.out, 'usage: node apply.mjs --in a.wav --out b.wav --regions "<json>"');
    const regions = args.regions ? JSON.parse(args.regions)
      : JSON.parse(fs.readFileSync(args['regions-file'], 'utf8'));
    console.log(JSON.stringify(run({ input: args.in, output: args.out, regions })));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}
