
// Offline listening approximation only. Does not isolate breath from consonants/noise.
const RATE = 48000;
const need = (ok, message) => { if (!ok) throw new Error(message); };

export function validateWindows(document, frames, sample, baselineSha) {
  need(document && document.sample === sample && document.baseline_sha256 === baselineSha,
    'Window document must match the selected sample and exact NF43 baseline hash');
  need(Array.isArray(document.windows) && document.windows.length > 0 && document.windows.length <= 12,
    'Provide 1-12 explicit time windows; empty/automatic windows are not allowed');
  const ranges = document.windows.map((item) => {
    need(Number.isFinite(item.start) && Number.isFinite(item.end)
      && item.start >= 0 && item.end <= frames / RATE && item.end > item.start, 'Invalid time window');
    const start = Math.round(item.start * RATE), end = Math.round(item.end * RATE);
    need(end - start >= 5760, 'Each window must be at least 120ms including internal fades');
    return { start, end, note: typeof item.note === 'string' ? item.note.slice(0, 500) : '' };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) need(ranges[i].start >= ranges[i - 1].end, 'Time windows overlap');
  return ranges;
}

function lowPassKernel() {
  const taps = 129, center = 64, cutoff = 6000 / RATE;
  const h = new Float64Array(taps);
  let total = 0;
  for (let j = 0; j < taps; j++) {
    const n = j - center;
    const ideal = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    h[j] = ideal * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / (taps - 1)));
    total += h[j];
  }
  for (let j = 0; j < taps; j++) h[j] /= total;
  return h;
}

export function applyLocalMask(original, ranges) {
  const h = lowPassKernel();
  const output = Float64Array.from(original);
  const touched = new Uint8Array(original.length);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) {
      const distance = Math.min(1, (i - range.start) / 1920, (range.end - 1 - i) / 1920);
      const weight = (1 - Math.cos(Math.PI * Math.max(0, distance))) / 2;
      if (weight === 0) continue;
      let low = 0;
      for (let j = 0; j < h.length; j++) {
        const source = i + j - 64;
        if (source >= 0 && source < original.length) low += original[source] * h[j];
      }
      // Centered FIR has zero phase. The 40ms fades are entirely inside the window.
      output[i] = original[i] - 0.10 * weight * (original[i] - low);
      touched[i] = 1;
    }
  }
  return { samples: output, touched };
}
