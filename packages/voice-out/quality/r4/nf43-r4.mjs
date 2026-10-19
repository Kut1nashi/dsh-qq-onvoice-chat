
const RATE = 48000;
const SIZE = 2048;
const HOP = 512;
const BINS = SIZE / 2 + 1;
const need = (ok, message) => { if (!ok) throw new Error(message); };

export function fft(real, imaginary, inverse = false) {
  const n = real.length;
  need(n > 1 && (n & (n - 1)) === 0 && imaginary.length === n, 'FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const baseReal = Math.cos(angle), baseImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const p = start + j, q = p + length / 2;
        const tr = real[q] * wr - imaginary[q] * wi;
        const ti = real[q] * wi + imaginary[q] * wr;
        real[q] = real[p] - tr; imaginary[q] = imaginary[p] - ti;
        real[p] += tr; imaginary[p] += ti;
        const nextReal = wr * baseReal - wi * baseImaginary;
        wi = wr * baseImaginary + wi * baseReal; wr = nextReal;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}

const window = Float64Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SIZE - 1)));

export function analyze(samples) {
  const frames = [];
  for (let start = -SIZE; start < samples.length; start += HOP) {
    const real = new Float64Array(SIZE), imaginary = new Float64Array(SIZE);
    let energy = 0;
    for (let i = 0; i < SIZE; i++) {
      const position = start + i;
      const value = position >= 0 && position < samples.length ? samples[position] : 0;
      energy += value * value; real[i] = value * window[i];
    }
    fft(real, imaginary);
    const power = new Float64Array(BINS);
    let total = 0;
    for (let k = 0; k < BINS; k++) { power[k] = real[k] ** 2 + imaginary[k] ** 2; total += power[k]; }
    frames.push({ start, center: (start + SIZE / 2) / RATE, real, imaginary, power, total, rms: Math.sqrt(energy / SIZE) });
  }
  return frames;
}

export function synthesize(frames, count, gains = null) {
  const output = new Float64Array(count), normalization = new Float64Array(count);
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f], real = Float64Array.from(frame.real), imaginary = Float64Array.from(frame.imaginary);
    if (gains) for (let k = 0; k < BINS; k++) {
      const gain = gains[f][k];
      real[k] *= gain; imaginary[k] *= gain;
      if (k > 0 && k < SIZE / 2) { real[SIZE - k] *= gain; imaginary[SIZE - k] *= gain; }
    }
    fft(real, imaginary, true);
    for (let i = 0; i < SIZE; i++) {
      const target = frame.start + i;
      if (target >= 0 && target < count) { output[target] += real[i] * window[i]; normalization[target] += window[i] ** 2; }
    }
  }
  for (let i = 0; i < count; i++) { need(normalization[i] > 1e-8, 'Overlap-add normalization failed'); output[i] /= normalization[i]; }
  return output;
}

function floorAt(frequency, highFloor) {
  if (frequency <= 160) return 1;
  if (frequency < 400) return 1 - 0.10 * (frequency - 160) / 240;
  if (frequency <= 4500) return 0.90;
  if (frequency < 6500) return 0.90 + (highFloor - 0.90) * (frequency - 4500) / 2000;
  return highFloor;
}

function meanAround(values, k, radius = 2) {
  let sum = 0, count = 0;
  for (let j = Math.max(0, k - radius); j <= Math.min(values.length - 1, k + radius); j++) { sum += values[j]; count++; }
  return sum / count;
}

function maskWeight(i, start, end) {
  const progress = Math.max(0, Math.min(1, (i - start) / 1920, (end - 1 - i) / 1920));
  return (1 - Math.cos(Math.PI * progress)) / 2;
}

export function blendWithAnchor(original, processed, regions) {
  const output = Float64Array.from(original), logs = [];
  for (const region of regions) {
    const start = Math.round(region.start * RATE), end = Math.round(region.end * RATE);
    need(start >= 0 && end <= original.length && end - start >= 5760, 'Invalid selected region');
    const anchors = [];
    for (let s = start; s < end; s += 960) {
      const e = Math.min(s + 960, end);
      let power = 0;
      for (let i = s; i < e; i++) power += original[i] ** 2;
      if (power / (e - s) > 10 ** (-35 / 10)) for (let i = s; i < e; i++) anchors.push(i);
    }
    need(anchors.length > 0, 'No high-level original reference windows');
    let a = 0, b = 0, c = 0;
    for (const i of anchors) {
      const weight = maskWeight(i, start, end);
      const left = (1 - weight) * original[i], right = weight * processed[i];
      a += right ** 2; b += 2 * left * right; c += left ** 2 - original[i] ** 2;
    }
    const gain = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
    const gainDb = 20 * Math.log10(gain);
    need(Number.isFinite(gainDb) && Math.abs(gainDb) <= 0.30, 'Foreground level correction exceeds 0.30dB; stopped for review');
    for (let i = start; i < end; i++) {
      const weight = maskWeight(i, start, end);
      output[i] = original[i] + weight * (gain * processed[i] - original[i]);
    }
    logs.push({ start: region.start, end: region.end, foreground_reference_samples: anchors.length, within_region_fixed_gain_db: gainDb });
  }
  return { samples: output, logs };
}

export function localSpectralCleanup(original, regions) {
  const frames = analyze(original);
  const proxies = regions.map((region) => {
    const selected = frames.filter((f) => f.center >= region.start && f.center < region.end && f.rms > 10 ** (-65 / 20));
    need(selected.length >= 8, 'Too few non-silent local frames for a bounded spectral proxy');
    const logPower = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const sorted = selected.map((f) => f.power[k]).sort((a, b) => a - b);
      logPower[k] = Math.log(Math.max(1e-20, sorted[Math.floor((sorted.length - 1) * 0.15)]));
    }
    return { frames: selected.length, power: Float64Array.from(logPower, (_, k) => Math.exp(meanAround(logPower, k))) };
  });
  const membership = frames.map((f) => regions.findIndex((r) => f.center >= r.start - SIZE / RATE / 2 && f.center <= r.end + SIZE / RATE / 2));
  const rawGains = frames.map((frame, index) => {
    const regionIndex = membership[index], gain = new Float64Array(BINS).fill(1);
    if (regionIndex < 0) return gain;
    const region = regions[regionIndex], proxy = proxies[regionIndex].power;
    for (let k = 0; k < BINS; k++) {
      const floor = floorAt(k * RATE / SIZE, region.highFloor);
      const wiener = Math.sqrt(Math.max(0, 1 - 0.60 * proxy[k] / Math.max(frame.power[k], 1e-20)));
      gain[k] = Math.max(floor, wiener);
    }
    return Float64Array.from(gain, (_, k) => Math.min(1, Math.max(floorAt(k * RATE / SIZE, region.highFloor), meanAround(gain, k))));
  });
  const gains = rawGains.map((g, index) => {
    const regionIndex = membership[index];
    if (regionIndex < 0) return g;
    const region = regions[regionIndex], frame = frames[index], proxy = proxies[regionIndex].power;
    return Float64Array.from(g, (value, k) => {
      const previous = rawGains[Math.max(0, index - 1)][k], next = rawGains[Math.min(rawGains.length - 1, index + 1)][k];
      const strong = frame.power[k] >= 30 * proxy[k] || frame.power[k] > frame.total * 0.01;
      return Math.min(1, Math.max(floorAt(k * RATE / SIZE, region.highFloor), strong ? 0.995 : 0, 0.25 * previous + 0.5 * value + 0.25 * next));
    });
  });
  const processed = synthesize(frames, original.length, gains);
  const blended = blendWithAnchor(original, processed, regions);
  return { ...blended, proxyFrames: proxies.map((p) => p.frames) };
}

export function metrics(original, output, regions) {
  let changed = 0, outside = 0, peak = 0;
  const ranges = regions.map((r) => ({ start: Math.round(r.start * RATE), end: Math.round(r.end * RATE) }));
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== output[i]) {
      changed++;
      if (!ranges.some((r) => i >= r.start && i < r.end)) outside++;
    }
    peak = Math.max(peak, Math.abs(output[i]));
  }
  need(original.length === output.length && outside === 0, 'Duration or samples outside selected regions changed');
  const anchors = regions.map((region) => {
    const start = Math.round(region.start * RATE), end = Math.round(region.end * RATE);
    let sourcePower = 0, outputPower = 0;
    for (let s = start; s < end; s += 960) {
      const e = Math.min(s + 960, end); let energy = 0;
      for (let i = s; i < e; i++) energy += original[i] ** 2;
      if (energy / (e - s) > 10 ** (-35 / 10)) {
        sourcePower += energy;
        for (let i = s; i < e; i++) outputPower += output[i] ** 2;
      }
    }
    return { start: region.start, end: region.end, foreground_anchor_difference_db: 10 * Math.log10(outputPower / sourcePower) };
  });
  return { frames: output.length, seconds: output.length / RATE, peak_dbfs: 20 * Math.log10(peak),
    changed_samples: changed, outside_regions_changed_samples: outside, anchors, full_scale_samples: 0 };
}
