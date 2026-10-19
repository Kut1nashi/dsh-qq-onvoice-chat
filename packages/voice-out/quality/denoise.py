"""NF43 接入修复：固定滤镜、EOF 保护、非循环对齐、一次 PCM 量化。

CLI 与旧版相同：python denoise.py <in.wav> <out.wav>
仅支持 48kHz / mono / PCM16。失败不写目标文件，由原有调用方保留输入。
这不是新音色档位，也不是 R4；不得对已降噪的文件再次执行。
"""
from __future__ import annotations

import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

import numpy as np

FFMPEG = os.environ.get("DENOISE_FFMPEG", "ffmpeg")
FILTER = "afftdn=nr=12:nf=-43:tn=0"
RATE = 48000
EOF_GUARD_FRAMES = 4800
MAX_LAG = 2400
ANCHOR_THR_DB = -35.0
WIN_MS = 20


def need(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def load(path: str):
    with wave.open(str(path), "rb") as w:
        need((w.getframerate(), w.getnchannels(), w.getsampwidth()) == (RATE, 1, 2),
             "Only 48kHz / mono / PCM16 input is supported")
        frames = w.getnframes()
        raw = w.readframes(frames)
    need(frames > 0 and len(raw) == frames * 2, "Empty or truncated WAV")
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0, RATE


def encode(x: np.ndarray) -> tuple[bytes, np.ndarray]:
    need(len(x) > 0 and bool(np.isfinite(x).all()), "Non-finite or empty output")
    pcm = np.rint(x * 32768.0)
    # Full-scale samples are rejected, never silently clipped or wrapped.
    need(bool(((pcm > -32768) & (pcm < 32767)).all()), "Full-scale output; stopped")
    pcm = pcm.astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return out.getvalue(), pcm.astype(np.float64) / 32768.0


def dbfs(value: float) -> float:
    need(math.isfinite(value) and value > 0, "No finite non-zero signal")
    return 20 * math.log10(value)


def speech_mask(x: np.ndarray, sr: int = RATE) -> np.ndarray:
    win = int(sr * WIN_MS / 1000)
    mask = np.zeros(len(x), dtype=bool)
    for start in range(0, len(x), win):
        stop = min(start + win, len(x))
        if np.mean(x[start:stop] ** 2) > 10 ** (ANCHOR_THR_DB / 10):
            mask[start:stop] = True
    need(bool(mask.any()), "No original high-level reference windows; stopped")
    return mask


def anchor_rms(x: np.ndarray, mask: np.ndarray) -> float:
    need(len(x) == len(mask) and bool(mask.any()), "Invalid anchor mask")
    return dbfs(float(np.sqrt(np.mean(x[mask] ** 2))))


def lag_samples(a: np.ndarray, b: np.ndarray, max_lag: int = MAX_LAG) -> int:
    """Positive means b is delayed. Keep that sign when slicing actual output."""
    n = min(len(a), len(b))
    need(n > max_lag, "Signal is too short for delay estimation")
    aa = a[:n] - a[:n].mean()
    bb = b[:n] - b[:n].mean()
    size = 1 << (2 * n - 1).bit_length()
    c = np.fft.irfft(np.fft.rfft(bb, size) * np.conj(np.fft.rfft(aa, size)), size)
    candidates = np.concatenate((c[-max_lag:], c[:max_lag + 1]))
    return int(np.argmax(candidates) - max_lag)


def recover_guarded_output(original: np.ndarray, raw: np.ndarray):
    n = len(original)
    need(bool(np.isfinite(raw).all()), "Non-finite filter output")
    need(n + EOF_GUARD_FRAMES - MAX_LAG <= len(raw) <= n + EOF_GUARD_FRAMES,
         "Filter frame loss exceeds extra EOF guard; stopped")
    guarded = np.pad(original, (0, EOF_GUARD_FRAMES))
    # Zero fill here is only for the correlation calculation, never the returned audio.
    comparable = np.pad(raw, (0, len(guarded) - len(raw)))
    lag = lag_samples(guarded, comparable)
    need(0 <= lag < MAX_LAG, "Negative or boundary delay; stopped")
    need(n + lag <= len(raw), "Actual output does not cover all requested samples")
    lead = int(np.argmax(original != 0)) if bool((original != 0).any()) else n
    tail = int(np.argmax(original[::-1] != 0)) if bool((original != 0).any()) else n
    need(lead >= max(lag, MAX_LAG) and tail >= max(lag, MAX_LAG),
         "Insufficient original zero padding for safe compensation")
    tolerance = 2 / 32768.0
    need(not lag or float(np.max(np.abs(raw[:lag]))) <= tolerance,
         "Non-silent discarded prefix")
    extra = raw[n + lag:]
    need(not len(extra) or float(np.max(np.abs(extra))) <= tolerance,
         "Non-silent extra EOF guard")
    selected = raw[lag:lag + n].copy()
    corr = float(np.corrcoef(original, selected)[0, 1])
    need(math.isfinite(corr) and corr >= 0.95, "Unexpected aligned correlation; stopped")
    return selected, {
        "original_frames": n, "extra_input_zero_frames": EOF_GUARD_FRAMES,
        "filter_input_frames": len(guarded), "filter_output_frames": len(raw),
        "eof_frames_not_emitted": len(guarded) - len(raw),
        "selected_filter_output_offset": lag, "selected_filter_output_frames": n,
        "available_filter_guard_after_selection": len(raw) - n - lag,
        "no_missing_selected_samples_filled": True, "aligned_correlation": corr,
    }


def match_and_encode(original: np.ndarray, processed: np.ndarray, mask: np.ndarray):
    need(len(original) == len(processed), "Frame count changed")
    ref = anchor_rms(original, mask)
    gain_db = ref - anchor_rms(processed, mask)
    need(math.isfinite(gain_db) and abs(gain_db) <= 1.0, "Gain exceeds 1dB; stopped")
    data, checked = encode(processed * 10 ** (gain_db / 20))
    actual = anchor_rms(checked, mask)
    need(abs(actual - ref) < 0.01, "Encoded anchor RMS mismatch; stopped")
    return data, {
        "gain_db": round(gain_db, 6), "anchor_ref_dbfs": round(ref, 6),
        "anchor_out_dbfs": round(actual, 6),
        "anchor_difference_db": round(actual - ref, 6),
        "peak_dbfs": round(dbfs(float(np.max(np.abs(checked)))), 6), "clipped": 0,
    }


def process(src: str, dst: str) -> dict:
    source, target = Path(src).resolve(), Path(dst).resolve()
    need(source != target and not (target.exists() and os.path.samefile(source, target)),
         "Input and output must differ")
    original, sr = load(str(source))
    mask = speech_mask(original, sr)
    guarded_bytes, _ = encode(np.pad(original, (0, EOF_GUARD_FRAMES)))
    with tempfile.TemporaryDirectory(prefix="nf43-") as temporary:
        guarded = Path(temporary) / "input-guarded.wav"
        filtered = Path(temporary) / "filtered.f32"
        guarded.write_bytes(guarded_bytes)
        subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
             "-i", str(guarded), "-af", FILTER, "-ar", str(sr), "-ac", "1",
             "-c:a", "pcm_f32le", "-f", "f32le", str(filtered)],
            check=True, timeout=120, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        raw_bytes = filtered.read_bytes()
        need(len(raw_bytes) % 4 == 0, "Truncated float output")
        raw = np.frombuffer(raw_bytes, dtype="<f4").astype(np.float64)
    aligned, compatibility = recover_guarded_output(original, raw)
    data, metrics = match_and_encode(original, aligned, mask)
    # Stage beside the destination so replacement stays atomic on Windows too.
    fd, staged = tempfile.mkstemp(prefix=".nf43-", suffix=".wav", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(staged, target)
    finally:
        if os.path.exists(staged):
            os.remove(staged)
    return {
        "src": src, "dst": dst, "filter": FILTER, "implementation": "nf43-guarded-v1",
        "frames": len(original), "lag_corrected": compatibility["selected_filter_output_offset"],
        **metrics, "compatibility": compatibility,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python denoise.py <in.wav> <out.wav>", file=sys.stderr)
        raise SystemExit(2)
    try:
        print(json.dumps(process(sys.argv[1], sys.argv[2]), ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(f"NF43 stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
