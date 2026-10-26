// Test Rig: movement in the arena (jumps, slide, bullet jump, wall run, glide, roll, ledge climb), the animation
// state machine, and the pose applier on a runtime Mixamo skeleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TUNE, ARENA, START, newPlayer, step, findLedge, groundAt, pushOut, topAt, facingYaw, animState, stepAnim, newAnim, stateLabel, poseFor, mixPose, wrapSpin, STATES, LABELS } from '../public/lib/testrig.js';
import { makeRig, applyPose } from '../public/lib/testrig-rig.js';

const DT = 1 / 120;
// Run n steps with the same input (jump and dodge are presses: held across steps counts once).
function go(s, input, seconds, world = ARENA) {
  for (let i = 0; i < Math.round(seconds / DT); i++) s = step(s, input, DT, world);
  return s;
}
const hs = (s) => Math.hypot(s.vel[0], s.vel[2]);
const at = (pos, extra = {}) => ({ ...newPlayer(pos), ...extra });
const FLAT = []; // nothing but the floor

test('arena: every block stands on the floor inside the walls, and the start is clear', () => {
  for (const s of ARENA) {
    assert.equal(s.min[1], 0);
    assert.ok(s.max[0] > s.min[0] && s.max[1] > 0 && s.max[2] > s.min[2]);
    assert.ok(s.min[0] >= -16 && s.max[0] <= 16 && s.min[2] >= -16 && s.max[2] <= 16);
  }
  assert.equal(groundAt(ARENA, START[0], START[2]), 0);
  const p = [...START]; assert.equal(pushOut(ARENA, p, 0), null);
});

test('standing still stays still and idle', () => {
  const s = go(newPlayer(), {}, 1);
  assert.deepEqual(s.pos.map((v) => +v.toFixed(6)), START);
  assert.equal(animState(s), 'idle');
});

test('moves relative to the camera: W with the camera turned 90° goes along +x', () => {
  const s = go(at([0, 0, 0]), { z: 1, yaw: Math.PI / 2 }, 1, FLAT);
  assert.ok(s.pos[0] > 3 && Math.abs(s.pos[2]) < 1e-6, s.pos.join());
  assert.ok(Math.abs(hs(s) - TUNE.run) < 1e-6);
  const d = go(at([0, 0, 0]), { x: 1 }, 1, FLAT); // D with the camera looking along +z: to the right, -x
  assert.ok(d.pos[0] < -3);
});

test('sprint is faster than run and shows as sprint', () => {
  const s = go(at([0, 0, 0]), { z: 1, sprint: true }, 1, FLAT);
  assert.ok(Math.abs(hs(s) - TUNE.sprint) < 1e-6);
  assert.equal(animState(s), 'sprint');
  assert.equal(animState(go(at([0, 0, 0]), { z: 1 }, 1, FLAT)), 'run');
});

test('jump, double jump, and no third jump until landing', () => {
  let s = step(newPlayer([0, 0, 0]), { jump: true }, DT, FLAT);
  assert.equal(s.grounded, false);
  assert.equal(s.jumpsLeft, 1, 'the ground jump does not use the air jump');
  s = go(s, {}, 0.25, FLAT);
  const vy = s.vel[1];
  s = step(s, { jump: true }, DT, FLAT);
  assert.equal(s.jumpsLeft, 0);
  assert.ok(s.vel[1] > vy && Math.abs(s.vel[1] - (TUNE.doubleJump - TUNE.gravity * DT)) < 1e-6);
  assert.equal(stateLabel(animState(s), s), 'Double jump');
  s = go(s, {}, 0.1, FLAT);
  const before = s.vel[1];
  s = step(s, { jump: true }, DT, FLAT);
  assert.ok(s.vel[1] < before, 'third press does nothing');
  s = go(s, {}, 2, FLAT);
  assert.ok(s.grounded && s.jumpsLeft === 1 && s.mode === 'ground');
});

test('holding jump is one jump, not a jump every frame', () => {
  const s = go(newPlayer([0, 0, 0]), { jump: true }, 0.3, FLAT);
  assert.equal(s.jumpsLeft, 1);
});

test('slide: crouch while sprinting slides, crouch while running only crouches; slides slow down and stop', () => {
  let s = go(at([0, 0, 0]), { z: 1, sprint: true }, 1, FLAT);
  s = step(s, { z: 1, sprint: true, crouch: true }, DT, FLAT);
  assert.equal(s.mode, 'slide');
  assert.equal(animState(s), 'slide');
  const v0 = hs(s);
  s = go(s, { z: 1, crouch: true }, 0.5, FLAT);
  assert.ok(hs(s) < v0 && s.mode === 'slide');
  s = go(s, { z: 1, crouch: true }, 2, FLAT);
  assert.equal(s.mode, 'ground'); assert.equal(animState(s), 'crouch');
  let r = go(at([0, 0, 0]), { z: 1 }, 1, FLAT);
  r = step(r, { z: 1, crouch: true }, DT, FLAT);
  assert.equal(r.mode, 'ground'); assert.equal(animState(r), 'crouch');
  r = go(r, { z: 1, crouch: true }, 1, FLAT);
  assert.ok(Math.abs(hs(r) - TUNE.crouchSpeed) < 1e-6);
  let e = go(at([0, 0, 0]), { z: 1, sprint: true }, 1, FLAT);
  e = go(e, { z: 1, sprint: true, crouch: true }, 0.2, FLAT);
  e = step(e, { z: 1, sprint: true }, DT, FLAT);
  assert.equal(e.mode, 'ground', 'letting go of crouch ends the slide');
});

test('landing with crouch held at speed goes straight into a slide', () => {
  let s = at([0, 0.3, 0], { grounded: false, mode: 'air', vel: [0, 0, 8] });
  s = go(s, { z: 1, crouch: true }, 0.4, FLAT);
  assert.equal(s.mode, 'slide');
});

test('bullet jump: crouch + jump launches fast where the camera looks, at least a little upwards', () => {
  let s = step(newPlayer([0, 0, 0]), { crouch: true, jump: true, yaw: 0, pitch: 0.5 }, DT, FLAT);
  assert.equal(s.jumpKind, 'bullet');
  assert.equal(stateLabel(animState(s), s), 'Bullet jump');
  assert.ok(Math.abs(Math.hypot(...s.vel) - TUNE.bullet) < 0.5);
  assert.ok(s.vel[2] > 10 && s.vel[1] > 5);
  assert.equal(s.jumpsLeft, 1, 'can still double jump after');
  const flat = step(newPlayer([0, 0, 0]), { crouch: true, jump: true, pitch: -1 }, DT, FLAT);
  assert.ok(flat.vel[1] > 0, 'looking down still leaves the ground');
  s = go(s, {}, 3, FLAT);
  assert.equal(s.jumpKind, null);
});

// A long wall along z at x = 2..3, 6 m tall.
const WALL = [{ min: [2, 0, -20], max: [3, 6, 20] }];
const besideWall = () => at([1.5, 1, 0], { grounded: false, mode: 'air', vel: [2, 3, 8], jumpsLeft: 0 });

test('wall run: moving fast along a tall wall in the air sticks to it, and it lasts wallrunTime', () => {
  let s = besideWall();
  s = go(s, { z: 1, x: -0.4 }, 0.1, WALL);
  assert.equal(s.mode, 'wallrun');
  assert.equal(animState(s), 'wallrun');
  assert.equal(s.jumpsLeft, 1, 'a wall run gives the air jump back');
  assert.deepEqual(s.wall.n, [-1, 0]);
  const t0 = s.timer;
  let tWall = 0;
  while (s.mode === 'wallrun' && tWall < 5) { s = step(s, { z: 1, x: -0.4 }, DT, WALL); tWall += DT; }
  assert.ok(Math.abs(tWall + t0 - TUNE.wallrunTime) < 3 * DT, `ran ${tWall + t0}`);
  assert.equal(s.mode, 'air');
  s = go(s, { z: 1, x: -0.4 }, 0.05, WALL);
  assert.notEqual(s.mode, 'wallrun', 'no instant second wall run on the same wall');
});

test('wall run: falls slowly, ends at the end of the wall, and jumping kicks away from it', () => {
  let s = go(besideWall(), { z: 1, x: -0.4 }, 0.1, WALL);
  const free = go(besideWall(), { z: 1, x: 0 }, 0.6, FLAT);
  const run = go(s, { z: 1, x: -0.4 }, 0.5, WALL);
  assert.ok(run.pos[1] > free.pos[1], 'higher than without the wall');
  const j = step(run, { z: 1, x: -0.4, jump: true }, DT, WALL);
  assert.equal(j.mode, 'air'); assert.equal(j.jumpKind, 'wall');
  assert.ok(j.vel[0] < -3 && j.vel[1] > 5, j.vel.join());
  assert.equal(j.jumpsLeft, 1, 'kick off, then a double jump is still there');
  const short = [{ min: [2, 0, -20], max: [3, 6, 3] }];
  let e = go(besideWall(), { z: 1, x: -0.4 }, 0.1, short);
  assert.equal(e.mode, 'wallrun');
  e = go(e, { z: 1, x: -0.4 }, 0.6, short);
  assert.equal(e.mode, 'air', 'past the end of the wall');
});

test('wall run needs speed along the wall: running straight at it does not', () => {
  const s = go(at([1.5, 1, 0], { grounded: false, mode: 'air', vel: [5, 3, 0] }), { x: -1 }, 0.1, WALL);
  assert.notEqual(s.mode, 'wallrun');
  const slow = go(at([1.5, 1, 0], { grounded: false, mode: 'air', vel: [2, 3, 2] }), { z: 1, x: -0.4 }, 0.1, WALL);
  assert.notEqual(slow.mode, 'wallrun');
});

test('ledge detection: a top within reach and above a step is a ledge, others are not', () => {
  const box = [{ min: [1, 0, -2], max: [3, 1.6, 2] }];
  const l = findLedge(box, [0.65, 0, 0], [1, 0]);
  assert.ok(l && l.top === 1.6 && l.to[0] > 1 && l.to[1] === 1.6);
  assert.equal(findLedge(box, [0.65, 0, 0], [-1, 0]), null, 'facing away');
  assert.equal(findLedge([{ min: [1, 0, -2], max: [3, 0.3, 2] }], [0.65, 0, 0], [1, 0]), null, 'a step, not a ledge');
  assert.equal(findLedge([{ min: [1, 0, -2], max: [3, 5, 2] }], [0.65, 0, 0], [1, 0]), null, 'out of reach');
  assert.ok(findLedge([{ min: [1, 0, -2], max: [3, 5, 2] }], [0.65, 3, 0], [1, 0]), 'in reach from higher up');
});

test('ledge climb: jump at a 1.6 m block while pushing into it climbs on top', () => {
  const box = [{ min: [1, 0, -2], max: [3, 1.6, 2] }];
  let s = at([0, 0, 0], { yaw: Math.PI / 2 });
  s = go(s, { z: 1, yaw: Math.PI / 2 }, 0.3, box);
  assert.ok(Math.abs(s.pos[0] - (1 - TUNE.radius)) < 1e-6, 'stopped by the block');
  s = step(s, { z: 1, yaw: Math.PI / 2, jump: true }, DT, box);
  let seen = false;
  for (let i = 0; i < 240 && !(seen && s.mode !== 'climb'); i++) { s = step(s, { z: 1, yaw: Math.PI / 2 }, DT, box); if (s.mode === 'climb') { seen = true; assert.equal(animState(s), 'climb'); } }
  assert.ok(seen, 'climbed');
  assert.equal(s.pos[1], 1.6);
  assert.ok(s.grounded && s.pos[0] > 1);
});

test('a tall block blocks, a ramp walks up', () => {
  const s = go(at([0, 0, 0]), { z: 1 }, 1, [{ min: [-2, 0, 1], max: [2, 3, 2] }]);
  assert.ok(s.pos[2] <= 1 - TUNE.radius + 1e-9);
  const ramp = [{ min: [-2, 0, 1], max: [2, 1.5, 7], rise: 'z+' }, { min: [-2, 0, 7], max: [2, 1.5, 9] }];
  assert.equal(topAt(ramp[0], 0, 4), 0.75);
  const up = go(at([0, 0, 0]), { z: 1 }, 1.8, ramp);
  assert.ok(up.pos[2] > 7.2 && up.pos[1] === 1.5 && up.grounded, up.pos.join());
});

test('walking off a ledge falls, with the air jump still there', () => {
  let s = at([0, 1, 0]);
  s = go(s, { z: 1 }, 0.5, [{ min: [-2, 0, -2], max: [2, 1, 1] }]);
  assert.ok(!s.grounded || s.pos[1] < 1);
  assert.equal(s.jumpsLeft, 1);
});

test('aim glide: right mouse while falling caps the fall speed, for glideTime at most', () => {
  const high = () => at([0, 30, 0], { grounded: false, mode: 'air' });
  let s = go(high(), { aim: true }, 0.5, FLAT);
  assert.ok(s.gliding && Math.abs(s.vel[1] + TUNE.glideFall) < 1e-6);
  assert.equal(animState(s), 'glide');
  const plain = go(high(), {}, 0.5, FLAT);
  assert.ok(plain.vel[1] < s.vel[1]);
  s = go(s, { aim: true }, TUNE.glideTime, FLAT);
  assert.ok(!s.gliding && s.vel[1] < -TUNE.glideFall, 'glide time used up');
  const up = step(at([0, 5, 0], { grounded: false, mode: 'air', vel: [0, 5, 0] }), { aim: true }, DT, FLAT);
  assert.ok(!up.gliding, 'no glide while going up');
});

test('roll: the dodge key rolls for rollTime, a hard landing rolls too', () => {
  let s = step(newPlayer([0, 0, 0]), { dodge: true, z: 1 }, DT, FLAT);
  assert.equal(s.mode, 'roll'); assert.equal(animState(s), 'roll');
  assert.ok(hs(s) >= TUNE.rollSpeed - 1e-6);
  s = go(s, { dodge: true, z: 1 }, TUNE.rollTime + 0.02, FLAT);
  assert.equal(s.mode, 'ground');
  const hard = go(at([0, 6, 0], { grounded: false, mode: 'air', vel: [0, -14, 4] }), { z: 1 }, 0.5, FLAT);
  const sawRoll = (() => { let x = at([0, 6, 0], { grounded: false, mode: 'air', vel: [0, -14, 4] }); for (let i = 0; i < 120; i++) { x = step(x, { z: 1 }, DT, FLAT); if (x.mode === 'roll') return true; } return false; })();
  assert.ok(sawRoll && hard.grounded);
  let soft = at([0, 0.5, 0], { grounded: false, mode: 'air', vel: [0, -3, 4] });
  soft = go(soft, { z: 1 }, 0.3, FLAT);
  assert.equal(soft.mode, 'ground');
});

test('state machine: every state has a label, and a run of inputs walks through the expected states', () => {
  for (const st of STATES) assert.ok(LABELS[st], st);
  let s = newPlayer([0, 0, 0]), a = newAnim();
  const seen = [];
  const run = (input, sec) => { for (let i = 0; i < Math.round(sec / DT); i++) { s = step(s, input, DT, FLAT); a = stepAnim(a, s, DT); if (seen.at(-1) !== a.state) seen.push(a.state); } };
  run({}, 0.2); run({ z: 1 }, 0.5); run({ z: 1, sprint: true }, 0.8); run({ z: 1, sprint: true, crouch: true }, 0.3);
  run({ z: 1 }, 0.3); run({ jump: true }, 0.25); run({}, 1.5);
  for (const st of ['idle', 'run', 'sprint', 'slide', 'jump', 'fall']) assert.ok(seen.includes(st), `${st} in ${seen}`);
  assert.equal(seen.at(-1), 'idle');
  assert.ok(seen.indexOf('jump') < seen.indexOf('fall'));
  assert.ok(seen.lastIndexOf('fall') < seen.lastIndexOf('idle'), 'lands, then stands');
  assert.ok(a.t > 0.5, 'time in state counts up');
  const b = stepAnim(newAnim(), { ...newPlayer(), grounded: true, vel: [0, 0, 5] }, 0.1);
  assert.equal(b.state, 'run'); assert.equal(b.t, 0); assert.ok(b.phase > 0);
});

test('poses: every state gives a full pose, mixing is linear, spin unwraps the short way', () => {
  const keys = Object.keys(poseFor(newAnim()));
  for (const st of STATES) {
    const p = poseFor({ state: st, t: 0.2, phase: 0.3 }, { ...newPlayer(), jumpKind: 'double', wall: { n: [1, 0] } });
    assert.deepEqual(Object.keys(p).sort(), keys.sort(), st);
    for (const v of Object.values(p).flat()) assert.ok(Number.isFinite(v), st);
  }
  const a = poseFor({ state: 'idle', t: 0 }), b = poseFor({ state: 'sprint', phase: 0.25 });
  const m = mixPose(a, b, 0.5);
  assert.equal(m.lean, (a.lean + b.lean) / 2);
  assert.deepEqual(mixPose(a, b, 1), b);
  assert.equal(wrapSpin({ ...a, spin: 360 }, { ...a, spin: 0 }).spin, 0);
  assert.equal(wrapSpin({ ...a, spin: 350 }, { ...a, spin: 0 }).spin, -10);
  // wall run leans into the wall: facing +z the body's left is +x, so a wall there (normal -x) leans left (+tilt)
  const wr = (n) => poseFor({ state: 'wallrun', phase: 0 }, { yaw: 0, wall: { n } }).tilt;
  assert.ok(wr([-1, 0]) > 0 && wr([1, 0]) < 0);
});

test('facingYaw: left +x and up +y face +z; turned models give their turn', () => {
  assert.ok(Math.abs(facingYaw([1, 0, 0], [0, 1, 0])) < 1e-9);
  assert.ok(Math.abs(facingYaw([0, 0, -1], [0, 1, 0]) - Math.PI / 2) < 1e-9); // left on -z: faces +x
  assert.ok(Math.abs(Math.abs(facingYaw([-1, 0, 0], [0, 1, 0])) - Math.PI) < 1e-9);
});

// A small humanoid like test/handpose.test.mjs: hips 1 m up, T-pose, Mixamo names and the 0.01 armature scale.
function rig() {
  const body = new THREE.Group();
  const arm = new THREE.Group(); arm.scale.setScalar(0.01); body.add(arm);
  const bones = {};
  const add = (name, parent, [x, y, z]) => { const b = new THREE.Bone(); b.name = `mixamorig:${name}`; b.position.set(x, y, z); (parent ? bones[parent] : arm).add(b); bones[name] = b; };
  add('Hips', null, [0, 100, 0]);
  add('Spine', 'Hips', [0, 10, 0]); add('Spine1', 'Spine', [0, 10, 0]); add('Spine2', 'Spine1', [0, 10, 0]); add('Neck', 'Spine2', [0, 15, 0]); add('Head', 'Neck', [0, 10, 0]);
  for (const [S, s] of [['Left', 1], ['Right', -1]]) {
    add(`${S}Shoulder`, 'Spine2', [s * 5, 12, 0]); add(`${S}Arm`, `${S}Shoulder`, [s * 10, 0, 0]); add(`${S}ForeArm`, `${S}Arm`, [s * 28, 0, 0]); add(`${S}Hand`, `${S}ForeArm`, [s * 25, 0, 0]);
    add(`${S}UpLeg`, 'Hips', [s * 10, -5, 0]); add(`${S}Leg`, `${S}UpLeg`, [0, -45, 0]); add(`${S}Foot`, `${S}Leg`, [0, -45, 0]); add(`${S}ToeBase`, `${S}Foot`, [0, -5, 10]);
  }
  const root = new THREE.Group(); root.add(body);
  root.updateMatrixWorld(true);
  return { root, body, model: arm, bones };
}
const wp = (b) => b.getWorldPosition(new THREE.Vector3());

test('rig: idle drops the arms from a T-pose, keeps bone lengths, and keeps the feet on the floor', () => {
  const { root, body, model, bones } = rig();
  const r = makeRig(model, body);
  assert.ok(Math.abs(r.ankle - 0.05) < 1e-6);
  const len = (a, b) => wp(bones[a]).distanceTo(wp(bones[b]));
  const l0 = [len('LeftArm', 'LeftForeArm'), len('LeftUpLeg', 'LeftLeg'), len('LeftLeg', 'LeftFoot')];
  applyPose(r, poseFor({ state: 'idle', t: 0 }));
  root.updateMatrixWorld(true);
  assert.ok(wp(bones.LeftHand).y < wp(bones.LeftArm).y - 0.4, 'left hand hangs');
  assert.ok(wp(bones.RightHand).y < wp(bones.RightArm).y - 0.4, 'right hand hangs');
  assert.ok(wp(bones.LeftHand).x > 0 && wp(bones.RightHand).x < 0, 'each hand on its own side');
  const l1 = [len('LeftArm', 'LeftForeArm'), len('LeftUpLeg', 'LeftLeg'), len('LeftLeg', 'LeftFoot')];
  l0.forEach((v, i) => assert.ok(Math.abs(v - l1[i]) < 1e-6));
  for (const st of ['idle', 'run', 'sprint', 'crouch', 'slide']) {
    applyPose(r, poseFor({ state: st, t: 0.1, phase: 0.2 }));
    const low = Math.min(wp(bones.LeftFoot).y, wp(bones.RightFoot).y);
    assert.ok(Math.abs(low - r.ankle) < 1e-6, `${st}: lower foot at ${low}`);
  }
  applyPose(r, poseFor({ state: 'crouch', t: 0, phase: 0 }));
  assert.ok(wp(bones.Hips).y < 0.9, 'crouch is lower');
});

test('rig: running swings the left leg forward when the right swings back; roll spins the whole body', () => {
  const { body, model, bones } = rig();
  const r = makeRig(model, body);
  applyPose(r, poseFor({ state: 'run', phase: 0.25 }));
  assert.ok(wp(bones.LeftFoot).z > wp(bones.Hips).z + 0.1 && wp(bones.RightFoot).z < wp(bones.Hips).z - 0.1);
  assert.ok(wp(bones.LeftHand).z < wp(bones.RightHand).z, 'arms swing the other way');
  applyPose(r, { ...poseFor({ state: 'roll', t: 0 }), spin: 180, plant: 0 });
  assert.ok(wp(bones.Head).y < wp(bones.Hips).y, 'upside down halfway through a roll');
  applyPose(r, poseFor({ state: 'idle', t: 0 })); // and back: nothing builds up
  assert.ok(wp(bones.Head).y > wp(bones.Hips).y);
  assert.ok(body.quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
});

test('a frame stamped before the last one (negative time) leaves the player where it was, never NaN', () => {
  const s = step(newPlayer(START), { z: 1 }, -0.02);
  assert.deepEqual(s.pos, START);
  assert.ok(step(s, { z: 1 }, DT).pos.every(Number.isFinite));
});
