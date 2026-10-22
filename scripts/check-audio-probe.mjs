// Read-only ffprobe compatibility and duration-limit check. No model or QQ calls.
import { probeAudio, inspectAudio } from '../packages/voice-out/lib/voice-core.js';

const [file, executable] = process.argv.slice(2);
if (!file || file === '--help') {
  console.log('node scripts/check-audio-probe.mjs <existing.wav> [ffprobe executable]');
  process.exitCode = file === '--help' ? 0 : 2;
} else {
  const ffprobePath = executable || process.env.FFPROBE_PATH || 'ffprobe';
  const probe = await probeAudio(file, { ffprobePath });
  if (!probe.ok || !(probe.duration > 0)) {
    console.log(JSON.stringify({ passed: false, probe }, null, 2));
    process.exitCode = 1;
  } else {
    const accepted = await inspectAudio(file, { ffprobePath, maxSeconds: probe.duration + 1 });
    const rejected = await inspectAudio(file, { ffprobePath, maxSeconds: probe.duration / 2 });
    const passed = accepted.ok && accepted.duration === probe.duration && !rejected.ok && rejected.duration === probe.duration;
    console.log(JSON.stringify({ passed, probe, normalLimit: accepted, reducedLimit: rejected }, null, 2));
    process.exitCode = passed ? 0 : 1;
  }
}
