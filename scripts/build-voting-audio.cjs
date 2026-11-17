const fs = require('node:fs');
const process = require('node:process');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Build once, play Opus directly on the host: no runtime FFmpeg/Opus encoder.
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'assets', 'voting.mp3');
const destination = path.join(root, 'dist', 'assets', 'voting.ogg');
try {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.statSync(source).isFile() || !fs.statSync(ffmpeg).isFile()) throw new Error();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'mp3', '-i', source,
    '-t', '15', '-vn', '-map_metadata', '-1', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-frame_duration', '20', '-b:a', '96000', '-f', 'ogg', destination],
  { env, timeout: 30000, windowsHide: true, stdio: 'pipe' });
  if (result.status !== 0 || fs.statSync(destination).size === 0) throw new Error();
  console.log('Prepared dist/assets/voting.ogg from assets/voting.mp3 (maximum 15 seconds).');
} catch {
  fs.rmSync(destination, { force: true });
  console.error('Could not prepare voting audio. Check assets/voting.mp3 and the local ffmpeg-static development dependency.');
  process.exitCode = 1;
}
