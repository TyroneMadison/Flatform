import test from 'node:test';
import assert from 'node:assert/strict';
import { detectModelType, retargetName, mapBones, validateMarkers, REQUIRED_MARKERS, POSES, poseBones, serializePose, deserializePose, applyStance, STANCE_DEFAULT, isStock, availableStances, guessTag, clipsFor, carClipFrame, wheelAngle, wheelStep, humanoidClipFrame } from '../public/lib/motion.js';

test('model type: humanoid and car fixtures detected; manual override wins', () => {
  assert.equal(detectModelType({ size: { x: 0.6, y: 1.9, z: 0.4 } }).type, 'humanoid');
  assert.equal(detectModelType({ size: { x: 1.9, y: 1.4, z: 4.6 }, partNames: ['body', 'wheel_FL', 'wheel_RR', 'door_L'] }).type, 'car');
  assert.equal(detectModelType({ boneNames: ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg'] }).type, 'humanoid');
  assert.equal(detectModelType({ size: { x: 0.6, y: 1.9, z: 0.4 } }, 'car').type, 'car');
  assert.equal(detectModelType({ size: { x: 1.9, y: 1.4, z: 4.6 } }, 'humanoid').type, 'humanoid');
});

test('retarget table maps Mixamo names and common variants', () => {
  for (const [src, std] of [['mixamorig:LeftForeArm', 'LeftForeArm'], ['upperarm_l', 'LeftArm'], ['thigh_r', 'RightUpLeg'], ['pelvis', 'Hips'], ['Spine_01', 'Spine'], ['calf_l', 'LeftLeg'], ['hand.R', 'RightHand'], ['DEF-head', 'Head'], ['mixamorig1:RightToeBase', 'RightToeBase']]) assert.equal(retargetName(src), std, src);
  assert.equal(retargetName('antenna'), null);
  const m = mapBones(['pelvis', 'Hips']);
  assert.equal(m.Hips, 'pelvis'); // first one wins
});

test('auto-rig fallback validates the required markers', () => {
  assert.deepEqual(validateMarkers({}).missing, REQUIRED_MARKERS);
  const ok = { chin: [0, 1.6, 0], leftWrist: [0.6, 1, 0], rightWrist: [-0.6, 1, 0], leftElbow: [0.4, 1.2, 0], rightElbow: [-0.4, 1.2, 0], leftKnee: [0.1, 0.5, 0], rightKnee: [-0.1, 0.5, 0], groin: [0, 0.9, 0] };
  assert.equal(validateMarkers(ok).ok, true);
  assert.equal(validateMarkers({ ...ok, chin: [0, 0.5, 0] }).ok, false);
  assert.deepEqual(validateMarkers({ ...ok, groin: [0, 'x', 0] }).missing, ['groin']);
});

test('pose presets serialize, deserialize and clamp', () => {
  for (const id of ['tpose', 'apose', 'idle', 'combat', 'hero', 'wave', 'salute', 'armsCrossed', 'kneel']) assert.ok(POSES[id], id);
  const p = { preset: 'hero', bones: { LeftArm: [10, 20, 30] } };
  assert.deepEqual(deserializePose(serializePose(p)), p);
  assert.deepEqual(deserializePose({ preset: 'nope', bones: { Tail: [1, 2, 3], Head: [400, 0, 0] } }), { preset: 'tpose', bones: { Head: [180, 0, 0] } });
  assert.deepEqual(poseBones('apose', { Head: [5, 0, 0] }).Head, [5, 0, 0]);
  assert.throws(() => poseBones('dab'));
});

test('car stance values apply and reset; openers hidden without tagged parts', () => {
  const low = applyStance({}, 'lowered');
  assert.equal(low.rideHeight, -0.04);
  assert.equal(applyStance(low, 'steerLeft').steer, 25);
  assert.equal(applyStance(low, 'steerLeft').rideHeight, -0.04);
  assert.equal(applyStance({ doors: 999 }, 'doorsOpen').doors, 65);
  assert.deepEqual(applyStance({ rideHeight: 0.1, steer: 20 }, 'stock'), STANCE_DEFAULT);
  assert.ok(isStock(applyStance({}, 'stock')));
  const none = availableStances({}).map((s) => s.id);
  assert.ok(!none.includes('doorsOpen') && !none.includes('hoodOpen') && !none.includes('trunkOpen'));
  const some = availableStances({ a: { tag: 'door' }, b: { tag: 'hood' } }).map((s) => s.id);
  assert.ok(some.includes('doorsOpen') && some.includes('hoodOpen') && !some.includes('trunkOpen'));
  assert.equal(guessTag('Wheel_RR'), 'wheelRear');
  assert.equal(guessTag('tire front left'), 'wheelFront');
  assert.equal(guessTag('Bonnet'), 'hood');
});

test('animation clips differ by type; wheel spin and drive-by rotate wheels per frame', () => {
  assert.notDeepEqual(clipsFor('car'), clipsFor('humanoid'));
  assert.ok(clipsFor('car').some((c) => c.id === 'driveBy'));
  assert.ok(clipsFor('humanoid').some((c) => c.id === 'walk'));
  // 36 km/h = 10 m/s on a 0.5 m wheel = 20 rad/s
  assert.equal(wheelAngle(1, 36, 0.5), 20);
  assert.ok(Math.abs(wheelStep(30, 36, 0.5) - 20 / 30) < 1e-12);
  const a = carClipFrame('wheelSpin', 0.5, { speed: 36, radius: 0.5 });
  assert.equal(a.wheel, 10);
  const d0 = carClipFrame('driveBy', 0, { speed: 36, radius: 0.5, length: 4, width: 12 });
  const d1 = carClipFrame('driveBy', 2, { speed: 36, radius: 0.5, length: 4, width: 12 });
  assert.equal(d0.x, -6); assert.equal(d1.x, 0); assert.equal(d1.wheel, 40);
  assert.ok(d1.roll > 0);
  const w = humanoidClipFrame('walk', 0.25);
  assert.ok(w.LeftUpLeg[0] > 0 && w.RightUpLeg[0] < 0);
});
