// 离线冒烟测试：只覆盖 voice-core 的纯函数，不需要引擎、网关、网络。
// 运行：node tests/smoke.mjs   （或 npm test）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUDIO_EXTS, formatBytes, formatDuration, isAudioFile, listAudioFiles,
  parseTargetKey, resolveAudioProcessing, resolveAudioSource,
  safeJoinLibrary, sanitizeUploadName, uniqueLibraryPath
} from '../packages/voice-out/lib/voice-core.js';

let pass = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.error(`  FAIL ${name}`); }
}

function throws(fn, name) {
  try { fn(); failures.push(name); console.error(`  FAIL ${name} (did not throw)`); }
  catch { pass += 1; console.log(`  ok   ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-smoke-'));
const lib = path.join(tmp, 'audio');
fs.mkdirSync(path.join(lib, 'sub'), { recursive: true });
fs.writeFileSync(path.join(lib, 'hello.mp3'), Buffer.alloc(2048, 1));
fs.writeFileSync(path.join(lib, 'sub', 'nested.wav'), Buffer.alloc(4096, 2));
fs.writeFileSync(path.join(lib, 'notes.txt'), 'not audio');
fs.writeFileSync(path.join(lib, 'upper.SILK'), Buffer.alloc(16, 3));

console.log('voice-core');

ok(AUDIO_EXTS.includes('.mp3') && AUDIO_EXTS.includes('.amr') && AUDIO_EXTS.includes('.silk'),
  'AUDIO_EXTS covers mp3/amr/silk');
ok(isAudioFile('x.SILK') === true, 'isAudioFile is case-insensitive');
ok(isAudioFile('x.txt') === false, 'isAudioFile rejects non-audio');
ok(formatBytes(2048) === '2.0 KB', 'formatBytes → KB');
ok(formatBytes(3 * 1024 * 1024) === '3.00 MB', 'formatBytes → MB');
ok(formatDuration(65) === '1分05秒', 'formatDuration → minutes');
ok(formatDuration(9) === '9秒', 'formatDuration → seconds');

const listed = listAudioFiles(lib);
ok(listed.length === 3, 'listAudioFiles finds 3 audio files (recursive, skips .txt)');
ok(listed.some((f) => String(f.rel ?? f).includes('nested.wav')), 'listAudioFiles walks subdirectories');

ok(parseTargetKey('group:123456')?.kind === 'group', 'parseTargetKey group');
ok(parseTargetKey('private:987654321')?.id === '987654321', 'parseTargetKey private');
ok(parseTargetKey('group:0') === null, 'parseTargetKey rejects id 0');
ok(parseTargetKey('group:0123') === null, 'parseTargetKey rejects leading zero');
ok(parseTargetKey('weird') === null, 'parseTargetKey rejects garbage');

ok(safeJoinLibrary(lib, '../escape.mp3') === null, 'safeJoinLibrary blocks .. traversal');
ok(safeJoinLibrary(lib, 'sub/nested.wav') !== null, 'safeJoinLibrary allows inside path');

const src = resolveAudioSource('hello.mp3', { voiceDir: lib });
ok(src.path && src.path.endsWith('hello.mp3'), 'resolveAudioSource resolves relative name');
ok(resolveAudioSource('missing.mp3', { voiceDir: lib }).path === null, 'resolveAudioSource misses gracefully');

const vol = resolveAudioProcessing({ volume: 2 });
ok(vol.volume === 2 && vol.loudness === null, 'resolveAudioProcessing volume multiplier');
const loud = resolveAudioProcessing({ normalize: true, loudness: 'loud' });
ok(loud.loudness === -13, 'resolveAudioProcessing loudness preset');
throws(() => resolveAudioProcessing({ volume: 99 }), 'resolveAudioProcessing rejects out-of-range volume');
throws(() => resolveAudioProcessing({ normalize: true, loudness: 'nope' }), 'resolveAudioProcessing rejects unknown preset');

ok(sanitizeUploadName('../../etc/passwd.mp3') === 'passwd.mp3', 'sanitizeUploadName strips paths');
ok(sanitizeUploadName('weird.exe').endsWith('.mp3'), 'sanitizeUploadName forces audio extension');

const uniq = uniqueLibraryPath(lib, 'hello.mp3');
ok(uniq.endsWith('hello-2.mp3'), 'uniqueLibraryPath avoids collision');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('failed:', failures.join(' | '));
  process.exit(1);
}
