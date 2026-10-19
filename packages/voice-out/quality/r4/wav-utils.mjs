// 48kHz / mono / PCM16 WAV 编解码与 SHA256；无外部依赖。
import fs from 'node:fs';
import crypto from 'node:crypto';

export const RATE = 48000;
const need = (ok, reason) => { if (!ok) throw new Error(reason); };

export function decodeWav(buffer) {
  need(buffer.length >= 44 && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE', 'Input must be a RIFF/WAVE file');
  need(buffer.readUInt32LE(4) + 8 === buffer.length, 'RIFF length mismatch');
  let fmt = null;
  let data = null;
  let cursor = 12;
  while (cursor + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', cursor, cursor + 4);
    const bytes = buffer.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    need(start + bytes <= buffer.length, `Truncated ${tag} chunk`);
    if (tag === 'fmt ') {
      need(!fmt && bytes >= 16, 'Invalid or duplicate fmt chunk');
      fmt = buffer.subarray(start, start + bytes);
    }
    if (tag === 'data') {
      need(!data, 'Duplicate data chunk');
      data = buffer.subarray(start, start + bytes);
    }
    cursor = start + bytes + (bytes % 2);
  }
  need(cursor === buffer.length && fmt && data, 'Incomplete WAV chunks');
  need(fmt.readUInt16LE(0) === 1 && fmt.readUInt16LE(2) === 1
    && fmt.readUInt32LE(4) === RATE && fmt.readUInt16LE(14) === 16
    && fmt.readUInt16LE(12) === 2 && fmt.readUInt32LE(8) === RATE * 2,
  'Only 48kHz mono 16-bit PCM inputs are accepted');
  need(data.length > 0 && data.length % 2 === 0 && data.length <= RATE * 2 * 60, 'Invalid WAV duration');
  const samples = new Float64Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}

export function encodeWav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    need(Number.isFinite(samples[i]), 'Non-finite audio sample');
    const scaled = samples[i] * 32768;
    const value = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
    need(value > -32768 && value < 32767, 'Audio reaches full scale; no automatic clipping applied');
    bytes.writeInt16LE(value, 44 + i * 2);
  }
  return bytes;
}

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export { need };
