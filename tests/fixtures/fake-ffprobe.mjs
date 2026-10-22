// A real child process emulating ffprobe releases that do not implement -o.
const args = process.argv.slice(2);
if (args.includes('-o')) {
  process.stderr.write('Failed to set value for option o: Option not found\n');
  process.exit(1);
}
const mode = process.env.DSH_TEST_PROBE_MODE || 'normal';
const metadata = {
  format: { duration: '3.25', format_name: 'wav' },
  streams: [
    { codec_type: 'video', codec_name: 'mjpeg' },
    { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 }
  ]
};
if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'empty') {
  // Intentionally no output.
} else if (mode === 'invalid') {
  process.stdout.write('{invalid JSON');
} else if (mode === 'large') {
  process.stdout.write(' '.repeat(1024 * 1024 + 1));
} else if (mode === 'nonzero') {
  process.stdout.write(JSON.stringify(metadata));
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(metadata));
}
