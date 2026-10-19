"""No model / network / production writes. Run with the same Python as denoise.py."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("denoise", HERE.parents[1] / "packages" / "voice-out" / "quality" / "denoise.py")
dn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dn)


def fixture():
    rng = np.random.default_rng(123)
    x = np.zeros(48000)
    x[7200:-7200] = rng.uniform(-0.15, 0.15, len(x) - 14400)
    return np.rint(x * 32768) / 32768


class DenoiseTests(unittest.TestCase):
    def test_delay_and_eof_loss_recover_actual_samples(self):
        x = fixture()
        for lag in (0, 1200):
            for loss in (0, 1405):
                with self.subTest(lag=lag, loss=loss):
                    raw = np.concatenate((np.zeros(lag), x, np.zeros(dn.EOF_GUARD_FRAMES)))
                    raw = raw[:len(x) + dn.EOF_GUARD_FRAMES - loss]
                    aligned, stats = dn.recover_guarded_output(x, raw)
                    np.testing.assert_array_equal(aligned, x)
                    self.assertEqual(stats['selected_filter_output_offset'], lag)
                    self.assertEqual(stats['eof_frames_not_emitted'], loss)
                    self.assertTrue(stats['no_missing_selected_samples_filled'])

    def test_negative_or_boundary_delay_rejected(self):
        x = fixture()
        for lag in (-1200, 2400):
            guarded = np.pad(x, (0, dn.EOF_GUARD_FRAMES))
            raw = np.roll(guarded, lag)
            with self.subTest(lag=lag), self.assertRaisesRegex(ValueError, 'delay'):
                dn.recover_guarded_output(x, raw)

    def test_truncation_and_discarded_audio_rejected(self):
        x = fixture()
        with self.assertRaisesRegex(ValueError, 'EOF guard'):
            dn.recover_guarded_output(x, x[:-1])
        raw = np.pad(x, (0, dn.EOF_GUARD_FRAMES))
        raw[-2] = .01
        with self.assertRaisesRegex(ValueError, 'Non-silent extra'):
            dn.recover_guarded_output(x, raw)
        raw = np.pad(x, (1200, dn.EOF_GUARD_FRAMES - 1200))
        raw[1] = .01
        with self.assertRaisesRegex(ValueError, 'Non-silent discarded'):
            dn.recover_guarded_output(x, raw)

    def test_quiet_input_has_no_nan_anchor(self):
        with self.assertRaisesRegex(ValueError, 'reference windows'):
            dn.speech_mask(np.zeros(48000))

    def test_partial_last_window_is_included(self):
        x = np.zeros(1000)
        x[960:] = .05
        self.assertEqual(int(dn.speech_mask(x).sum()), 40)

    def test_unity_roundtrip_and_one_lsb_are_exact(self):
        x = fixture()
        x[8000:8003] = [-1 / 32768, 0, 1 / 32768]
        _, checked = dn.encode(x)
        np.testing.assert_array_equal(checked, x)
        data, stats = dn.match_and_encode(x, x, dn.speech_mask(x))
        self.assertEqual(stats['gain_db'], 0)
        self.assertEqual(stats['anchor_difference_db'], 0)
        self.assertEqual(len(data), 44 + 2 * len(x))

    def test_large_gain_or_clipping_is_rejected(self):
        x = fixture()
        with self.assertRaisesRegex(ValueError, 'Gain exceeds'):
            dn.match_and_encode(x, .5 * x, dn.speech_mask(x))
        for value in (float('nan'), 1.01, -1.01):
            with self.subTest(value=value), self.assertRaises(ValueError):
                dn.encode(np.array([value]))

    def test_failed_filter_never_overwrites_input_or_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source.wav', Path(tmp) / 'destination.wav'
            original = dn.encode(fixture())[0]
            source.write_bytes(original)
            target.write_bytes(b'keep-existing-output')
            with patch.object(dn.subprocess, 'run', side_effect=RuntimeError('filter-failed')):
                with self.assertRaisesRegex(RuntimeError, 'filter-failed'):
                    dn.process(str(source), str(target))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(target.read_bytes(), b'keep-existing-output')
            with self.assertRaisesRegex(ValueError, 'must differ'):
                dn.process(str(source), str(source))


if __name__ == '__main__':
    unittest.main(verbosity=2)
