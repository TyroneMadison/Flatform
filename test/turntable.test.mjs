import test from 'node:test';
import assert from 'node:assert/strict';
import { planTurntable, ffmpegArgs, frameName, framePattern, RESOLUTIONS, extensionFor } from '../public/lib/turntable.js';
import { encodeVideo, findFfmpeg } from '../video.mjs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

test('turntable plan: 360 vs 180 frame angles, frame count, resolution and fps', () => {
  const full = planTurntable({ degrees: 360, frames: 72, fps: 30, resolution: '1080p' });
  assert.equal(full.angles.length, 72); assert.equal(full.angles[1], 5); assert.equal(full.angles.at(-1), 355);
  assert.equal(full.width, 1920); assert.equal(full.height, 1080); assert.equal(full.seconds, 2.4);
  const half = planTurntable({ degrees: 180, frames: 37, fps: 24, resolution: 'vertical' });
  assert.equal(half.angles.at(-1), 180); assert.equal(half.width, 1080); assert.equal(half.height, 1920);
  assert.deepEqual(RESOLUTIONS.square, [1080, 1080]); assert.deepEqual(RESOLUTIONS['4k'], [3840, 2160]);
  assert.throws(() => planTurntable({ degrees: 90 })); assert.throws(() => planTurntable({ resolution: '8k' })); assert.throws(() => planTurntable({ frames: 1 }));
});

test('ffmpeg args for MP4, WebM and WebM alpha', () => {
  const mp4 = ffmpegArgs({ input: 'f/%04d.png', output: 'o.mp4', fps: 30, format: 'mp4', quality: 'high', width: 1920, height: 1080 });
  assert.ok(mp4.includes('libx264') && mp4.includes('yuv420p') && mp4.includes('+faststart'));
  assert.equal(mp4[mp4.indexOf('-crf') + 1], '16'); assert.equal(mp4[mp4.indexOf('-framerate') + 1], '30');
  assert.ok(mp4[mp4.indexOf('-vf') + 1].startsWith('scale=1920:1080'));
  const webm = ffmpegArgs({ input: 'a', output: 'o.webm', format: 'webm' });
  assert.ok(webm.includes('libvpx-vp9') && webm.includes('yuv420p') && !webm.includes('-vf'));
  const alpha = ffmpegArgs({ input: 'a', output: 'o.webm', format: 'webmAlpha', seconds: 5 });
  assert.ok(alpha.includes('yuva420p')); assert.equal(alpha[alpha.indexOf('-t') + 1], '5');
  assert.equal(alpha.at(-1), 'o.webm');
  assert.throws(() => ffmpegArgs({ input: 'a', output: 'b', format: 'gif' }));
  assert.equal(extensionFor('webmAlpha'), '.webm');
});

test('PNG sequence naming with transparent background variant', () => {
  assert.equal(frameName('{name}_{variant}_{frame}', { name: 'Excalibur Prime', variant: 'transparent', frame: 7 }), 'Excalibur-Prime_transparent_0007.png');
  assert.equal(frameName('{name}_{frame}', { name: 'r8', frame: 12 }), 'r8_0012.png');
  assert.equal(framePattern('{name}_{frame}', { name: 'r8' }), 'r8_%04d.png');
});

test('encode: uses the picked folder, runs local ffmpeg only, rejects a missing folder', async () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); const c = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; };
  const outDir = path.join(os.tmpdir(), 'picked');
  const r = await encodeVideo({ ffmpeg: '/usr/bin/ffmpeg', framesDir: '/frames', pattern: 'r8_%03d.png', outDir, fileName: 'r8.mp4', spawn, format: 'mp4', fps: 60 });
  assert.equal(r.output, path.join(outDir, 'r8.mp4'));
  assert.equal(calls[0].cmd, '/usr/bin/ffmpeg');
  assert.ok(calls[0].args.every((a) => !/^https?:/.test(a)), 'no network URLs');
  await assert.rejects(encodeVideo({ ffmpeg: 'x', framesDir: '/f', pattern: 'a', outDir: 'relative', fileName: 'a.mp4', spawn }));
  await assert.rejects(encodeVideo({ ffmpeg: null, framesDir: '/f', pattern: 'a', outDir, fileName: 'a.mp4', spawn }), /ffmpeg not found/);
  assert.equal(findFfmpeg({ configured: '/opt/ff', exists: (p) => p === '/opt/ff', which: () => null }), '/opt/ff');
  assert.equal(findFfmpeg({ configured: '', env: {}, exists: () => false, which: () => null }), null);
});
