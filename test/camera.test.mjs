// Camera view modes, "Frame all" and the size lock: the pure maths in pipeline.js that studio.js and
// render/blender_turntable.py both follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAR_LENGTH, hfovOf, isCarShape, modelScale, fitDistance, frameOrbit } from '../public/lib/pipeline.js';

const CAR = { x: 1.9, y: 1.3, z: 4.6 }; // a normalised car
const TRIPO_CAR = { x: 4.3, y: 1.2, z: 1.9 }; // Tripo lays cars along X
const CENTURA = { x: 0.428, y: 1.0, z: 0.258 }; // the Centura Warframe model's raw GLB bounds
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('a car is longer than tall; a humanoid is not a car', () => {
  assert.equal(isCarShape(CAR), true);
  assert.equal(isCarShape(TRIPO_CAR), true);
  assert.equal(isCarShape({ x: 2, y: 2.2, z: 2 }), true); // a boxy van: not clearly taller
  assert.equal(isCarShape(CENTURA), false);
  assert.equal(isCarShape({ x: 1, y: 3, z: 1 }), false);
});

test('"Same size for every car" locks car length only; tall models keep a live Scale slider', () => {
  // Cars: exactly today's behaviour.
  close(modelScale(CAR, { sameSize: true, scale: 0.5 }), CAR_LENGTH / 4.6);
  close(modelScale(TRIPO_CAR, { sameSize: true, scale: 1.4 }), CAR_LENGTH / 4.3);
  close(modelScale(CAR, { sameSize: false, scale: 0.5 }), (CAR_LENGTH / 4.6) * 0.5);
  close(modelScale(CAR, {}), 1); // defaults: sameSize on, Fit
  // The humanoid: Fit makes its tallest side CAR_LENGTH (not 10.7 m tall as the footprint rule did), and the
  // size lock never applies, so Scale shrinks it below Fit.
  close(modelScale(CENTURA, { sameSize: true, scale: 1 }) * CENTURA.y, CAR_LENGTH);
  close(modelScale(CENTURA, { sameSize: true, scale: 0.3 }) * CENTURA.y, CAR_LENGTH * 0.3);
  close(modelScale(CENTURA, { sameSize: false, scale: 0.3 }), modelScale(CENTURA, { sameSize: true, scale: 0.3 }));
});

test('Frame all: the bounding sphere fits inside the frame on its tighter side, with padding', () => {
  const hfov = hfovOf(50);
  for (const [aspect, radius] of [[4 / 3, 1], [1, 2.6], [4 / 3, 0.4]]) {
    const d = fitDistance(radius, hfov, aspect);
    const half = Math.min(hfov / 2, Math.atan(Math.tan(hfov / 2) / aspect)); // the tighter half-angle
    close(Math.asin((radius * 1.1) / d), half, 1e-9);
    assert.ok(d * Math.sin(half) > radius, 'the whole sphere is inside the frame');
  }
  assert.ok(fitDistance(1, hfov, 1) < fitDistance(1, hfov, 4 / 3), 'a 4:3 frame is tighter vertically than a square one');
  assert.ok(fitDistance(1, hfovOf(135), 4 / 3) > fitDistance(1, hfovOf(18), 4 / 3), 'a long lens needs more distance');
  assert.ok(Number.isFinite(fitDistance(0, hfov, 1)));
});

test('Frame all in free roam keeps the line of sight and looks at the model', () => {
  const sphere = { center: [0.2, 2.3, 0], radius: 2.4 };
  const o = frameOrbit(sphere, [0.2, 4, 10], hfovOf(50), 4 / 3);
  assert.deepEqual(o.target, sphere.center);
  close(Math.hypot(...o.position.map((v, i) => v - sphere.center[i])), fitDistance(2.4, hfovOf(50), 4 / 3));
  const dir = o.position.map((v, i) => v - sphere.center[i]);
  close(dir[0], 0);
  close(dir[1] / dir[2], 1.7 / 10); // same direction as before
  // A camera sitting on the centre has no direction: a gentle front view is used.
  const flat = frameOrbit(sphere, sphere.center, hfovOf(50), 4 / 3);
  assert.ok(flat.position[2] > sphere.center[2] && flat.position[1] > sphere.center[1]);
});

test('the Blender script mirrors the view mode, orbit camera, fit and size rules', async () => {
  const py = await readFile(new URL('../render/blender_turntable.py', import.meta.url), 'utf8');
  assert.match(py, /"view": "car", "orbit": None, "fit": "footprint"/);
  for (const fn of ['def is_car_shape', 'def model_scale', 'def fit_distance', 'def free_camera']) assert.ok(py.includes(fn), fn);
  assert.match(py, /if s\["view"\] == "free" and s\["orbit"\]:\s+free_camera\(s\)/);
  assert.match(py, /1\.15 \* max\(size\.x, size\.y\)/); // the same 15% rule as isCarShape, in Blender's Z-up
});
