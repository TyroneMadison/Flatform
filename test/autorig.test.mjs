// Auto-rig from the model's own limbs (public/lib/autorig.js) on made-up bodies (test/fixtures/humanoid-mesh.mjs):
// which way it faces, the joints from cross-section slicing and the paths through the body, the binding (armour
// plates whole on the right limb, one-piece bodies blended across joints only), the checks that catch a bad rig,
// the landmark-click fallback, and Reset scene / Undo going back to the version from before the joints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { humanoidMesh } from './fixtures/humanoid-mesh.mjs';
import {
  autoRig, bodyFrame, voxelize, depthField, islandsOf, findJoints, bonesFrom, bindVertices, validateRig, poseStretch,
  jointsFromMarkers, cutWelds, chainOf, rigFailure, unriggedVersion, nextMarker, MARKERS, TEST_POSE,
} from '../public/lib/autorig.js';
import { BONES } from '../public/lib/motion.js';
import { createHistory } from '../public/lib/history.js';
import { rigLight, blockedByRig, STATUS_TEXT } from '../public/lib/render-status.js';

const H = 1.8;
const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (got, want, tol, label) => assert.ok(far(got, want) < tol, `${label}: ${got.map((v) => v.toFixed(2))} is ${far(got, want).toFixed(3)} m from ${want.map((v) => v.toFixed(2))}`);

test('which way the body faces: the legs and shoulders spread sideways, the toes point forward', () => {
  for (const facing of [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]]) {
    const f = bodyFrame(humanoidMesh({ arms: 'down', facing }).positions);
    near(f.forward, facing, 0.05, `forward for ${facing}`);
    assert.ok(Math.abs(f.left[1]) < 1e-9 && Math.abs(f.left[0] * f.forward[0] + f.left[2] * f.forward[2]) < 1e-9, 'left is sideways');
  }
});

test('joints sit at the real shoulders, elbows, wrists, hips, knees and ankles, whatever way it faces', () => {
  for (const arms of ['t', 'a', 'down']) {
    for (const facing of [[0, 0, 1], [1, 0, 0]]) {
      const m = humanoidMesh({ arms, facing });
      const r = autoRig(m.positions, m.tris);
      assert.deepEqual(r.problems, [], `${arms}/${facing}`);
      for (const k of ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'Hips', 'Neck', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm']) {
        near(r.joints[k], m.truth[k], 0.075 * H, `${arms}/${facing} ${k}`);
      }
      for (const k of ['LeftHand', 'RightHand']) near(r.joints[k], m.truth[k], 0.12 * H, `${arms}/${facing} ${k}`);
    }
  }
});

test('slicing: knees and ankles are the narrow points of each leg', () => {
  const m = humanoidMesh({ arms: 'a' });
  const r = autoRig(m.positions, m.tris);
  for (const s of ['Left', 'Right']) {
    assert.ok(Math.abs(r.joints[`${s}Leg`][1] - 0.5) < 0.05, `${s} knee height ${r.joints[`${s}Leg`][1]}`);
    assert.ok(r.joints[`${s}Foot`][1] > 0.03 && r.joints[`${s}Foot`][1] < 0.16, `${s} ankle height ${r.joints[`${s}Foot`][1]}`);
  }
});

test('armour plates are bound whole to the limb they sit on; nothing is unbound; no blend crosses limbs', () => {
  const m = humanoidMesh({ arms: 'a', pieces: 'armor' });
  const r = autoRig(m.positions, m.tris);
  assert.ok(r.ok, r.problems.join('; '));
  const { b0, b1, q } = r.weights;
  for (const p of m.plates) {
    const bones = new Set();
    for (let i = p.first; i < p.first + p.count; i++) { assert.equal(q[i], 255, 'a plate is rigid'); bones.add(BONES[b0[i]]); }
    assert.equal(bones.size, 1, `plate on ${p.bone} split across ${[...bones]}`);
    const got = [...bones][0];
    assert.equal(chainOf(got), chainOf(p.bone), `plate on ${p.bone} tied to ${got}`);
  }
  const parent = (b) => r.bones.find((x) => x.name === b)?.parent;
  for (let i = 0; i < q.length; i++) {
    assert.ok(b0[i] < BONES.length && b1[i] < BONES.length, 'every vertex has a bone');
    if (q[i] === 255 || b0[i] === b1[i]) continue;
    const a = BONES[b0[i]], b = BONES[b1[i]];
    assert.ok(parent(a) === b || parent(b) === a, `vertex ${i} blends ${a} with ${b}, which are not joined`);
  }
});

test('a one-piece body gets smooth weights across its joints', () => {
  const m = humanoidMesh({ arms: 't', pieces: 'one' });
  const r = autoRig(m.positions, m.tris);
  assert.ok(r.ok, r.problems.join('; '));
  assert.equal(r.report.rigid, 0);
  assert.ok([...r.weights.q].some((q) => q > 0 && q < 255), 'some vertices blend two bones');
});

test('the test pose (thigh up, knees bent, arms swung) tears nothing; a plate split between a leg and an arm (the old per-vertex binding) is caught', () => {
  const m = humanoidMesh({ arms: 'a' });
  const frame = bodyFrame(m.positions);
  const g = voxelize(m.positions, m.tris, frame);
  const depth = depthField(g);
  const islands = islandsOf(m.positions.length / 3, m.tris);
  const J = findJoints(g, depth).joints;
  const bones = bonesFrom(J, g.H);
  const bind = bindVertices(g, depth, bones, islands);
  const P = (i) => [g.local[i * 3], g.local[i * 3 + 1], g.local[i * 3 + 2]];
  const n = m.positions.length / 3;
  const good = poseStretch(bones, bind, P, n, m.tris, islands, g.H);
  assert.ok(!good.torn && good.stretched === 0 && good.drift < 0.08, JSON.stringify(good));
  // The old auto-rig bound each unweighted vertex on its own; on a sideways-facing model the "left" and "right" legs
  // were front and back and the hands landed on the hips, so one plate ended up half on a leg, half on an arm.
  const old = { ...bind, b0: bind.b0.slice(), b1: bind.b1.slice(), q: bind.q.slice() };
  const plate = m.plates.find((p) => p.bone === 'LeftUpLeg');
  for (let i = plate.first; i < plate.first + plate.count; i++) old.b0[i] = old.b1[i] = BONES.indexOf(i % 2 ? 'LeftUpLeg' : 'RightForeArm');
  const bad = poseStretch(bones, old, P, n, m.tris, islands, g.H);
  assert.ok(bad.worst > 3, `the split plate stretches: ${JSON.stringify(bad)}`);
  const v = validateRig(g, depth, bones, J, old, islands, m.tris);
  assert.ok(v.problems.includes('1 pieces were split between two limbs'), v.problems.join('; '));
});

test('validation: a leg plate tied to an arm, joints outside the body and lopsided limbs are caught in plain words', () => {
  const m = humanoidMesh({ arms: 'a' });
  const g = voxelize(m.positions, m.tris, bodyFrame(m.positions));
  const depth = depthField(g);
  const islands = islandsOf(m.positions.length / 3, m.tris);
  const J = findJoints(g, depth).joints;
  const bones = bonesFrom(J, g.H);
  const bind = bindVertices(g, depth, bones, islands);
  assert.ok(validateRig(g, depth, bones, J, bind, islands, m.tris).ok);
  // A shin plate tied to the left forearm.
  const plate = m.plates.find((p) => p.bone === 'LeftLeg');
  const s = islands.id[plate.first];
  const arm = BONES.indexOf('LeftForeArm');
  const wrong = { ...bind, b0: bind.b0.slice(), b1: bind.b1.slice(), rigid: bind.rigid.slice() };
  wrong.rigid[s] = arm;
  for (let i = plate.first; i < plate.first + plate.count; i++) { wrong.b0[i] = wrong.b1[i] = arm; }
  const v = validateRig(g, depth, bones, J, wrong, islands, m.tris);
  assert.ok(!v.ok && v.problems.some((p) => /tied to the wrong limb/.test(p)), v.problems.join('; '));
  // A joint off in the air.
  const out = validateRig(g, depth, bones, { ...J, LeftHand: [J.LeftHand[0] + 0.5, J.LeftHand[1], J.LeftHand[2]] }, bind, islands, m.tris);
  assert.ok(out.problems.some((p) => /outside the body \(LeftHand\)/.test(p)), out.problems.join('; '));
});

test('an arm bent across the body is not guessed: the rig says so plainly and offers the landmark clicks', () => {
  const m = humanoidMesh({ arms: 'bent' });
  const r = autoRig(m.positions, m.tris);
  assert.equal(r.ok, false);
  assert.ok(r.problems.length);
  const f = rigFailure(r.problems);
  assert.equal(f.fallback, 'markers');
  assert.match(f.error, /^Could not place the joints by itself: .+\. Show me where the joints are instead\.$/);
  // Not a person at all: a box.
  const box = humanoidMesh({ arms: 't' });
  const cube = new Float32Array(box.positions.length).map((_, i) => ((i * 7919) % 97) / 97);
  assert.equal(autoRig(cube, box.tris).ok, false);
});

test('landmark clicks (chin, groin, elbows, wrists, knees, ankles) make a good rig where detection gave up', () => {
  const m = humanoidMesh({ arms: 'bent' });
  const t = m.truth;
  const skin = (p, dz = 0.05) => [p[0], p[1], p[2] + dz]; // clicks land on the front of the skin, not in the middle
  const markers = {
    chin: [0, 1.56, 0.1], groin: [0, 0.86, 0.09],
    leftElbow: skin(t.LeftForeArm), leftWrist: skin(t.LeftHand, 0.03), rightElbow: skin(t.RightForeArm), rightWrist: skin(t.RightHand, 0.03),
    leftKnee: skin(t.LeftLeg), leftAnkle: skin(t.LeftFoot, 0.03), rightKnee: skin(t.RightLeg), rightAnkle: skin(t.RightFoot, 0.03),
  };
  assert.deepEqual(Object.keys(markers).sort(), [...MARKERS].sort());
  const r = autoRig(m.positions, m.tris, { markers });
  assert.ok(r.ok, r.problems.join('; '));
  for (const k of ['LeftForeArm', 'LeftHand', 'RightForeArm', 'LeftLeg', 'RightFoot']) near(r.joints[k], t[k], 0.04 * H, k);
  assert.deepEqual(r.report.outside, [], 'every joint inside the body, not on the skin where it was clicked');
  // Missing or nonsense clicks say what to do.
  const g = voxelize(m.positions, m.tris, bodyFrame(m.positions));
  assert.match(jointsFromMarkers(g, { ...markers, leftKnee: null }).problems[0], /^Click the left knee$/);
  assert.match(jointsFromMarkers(g, { ...markers, chin: [0, 0.5, 0] }).problems[0], /chin must be above the groin/);
  assert.equal(nextMarker({}), 'chin');
  assert.equal(nextMarker(markers), null);
});

test('faces welding two limbs together (a fist modelled into the thigh) are cut, not smeared', () => {
  const bones = BONES.map((name) => ({ name, parent: { Hips: null }[name] ?? 'Hips', head: [0, 0, 0], tail: [0, 1, 0] }));
  const bone = (n) => BONES.indexOf(n);
  const bind = { b0: Uint8Array.from([bone('RightHand'), bone('RightUpLeg'), bone('RightUpLeg'), bone('RightLeg'), bone('RightUpLeg'), bone('LeftUpLeg')]), b1: new Uint8Array(6), q: new Uint8Array(6).fill(255) };
  bind.b1.set(bind.b0);
  // hand-thigh-thigh, thigh-thigh-shin, thigh-shin-thigh, one thigh to the other
  const tris = Uint32Array.from([0, 1, 2, 1, 2, 3, 2, 3, 4, 4, 5, 2]);
  assert.deepEqual([...cutWelds(bones, bind, tris)], [0, 3]);
});

test('Reset scene goes back to the version from before the joints; undo keeps the version with the scene', () => {
  const model = { activeVersion: 3, versions: [{ n: 1 }, { n: 2, rigged: true, from: 1 }, { n: 3, rigged: true, note: 'Auto-rigged from version 2 in Blender' }] };
  assert.equal(unriggedVersion(model), 1);
  assert.equal(unriggedVersion({ activeVersion: 1, versions: [{ n: 1 }] }), 1);
  assert.equal(unriggedVersion({ activeVersion: 2, versions: [{ n: 1 }, { n: 2, rigged: true, note: 'Auto-rigged from version 1 in Blender' }] }), 1);
  // One history holds the scene and the version together: undo Add joints, redo it, undo a Reset scene.
  const h = createHistory({ now: () => 0, burst: 0 });
  const posed = { motion: { pose: { preset: 'tpose', bones: { LeftArm: [0, 0, -40] } }, keys: [{ t: 0, bones: {} }] } };
  h.push({ scene: {}, version: 1 }, 'Add joints'); // before the rig
  h.push({ scene: posed, version: 2 }, 'Reset scene'); // posed by hand, then reset
  let now = { scene: {}, version: 1 };
  now = h.undo(now);
  assert.deepEqual(now, { scene: posed, version: 2 }, 'undoing Reset scene brings back the rig and the hand pose');
  now = h.undo(now);
  assert.deepEqual(now, { scene: {}, version: 1 }, 'undoing Add joints goes back to the model without them');
  assert.deepEqual(h.redo(now), { scene: posed, version: 2 });
});

test('Undo and Reset reach the 3D view: the whole scene replaces the old one, and no pose means the bind pose', async () => {
  const { Studio } = await import('../public/lib/studio.js');
  const fake = { state: { motion: { pose: { preset: 'tpose', bones: { Head: [0, 30, 0] } } }, preset: 'cyclorama' }, built: true };
  for (const k of ['buildPreset', 'applyModel', 'applyLights', 'applyCamera', 'applyPaint', 'applyDecals', 'applyLook', 'applyExtras']) fake[k] = async () => {};
  await Studio.prototype.setState.call(fake, { preset: 'cyclorama' }, { replace: true });
  assert.equal(fake.state.motion, undefined, 'the pose is gone from the view, not left over');
  await Studio.prototype.setState.call(fake, { motion: { clip: 'walk' } });
  await Studio.prototype.setState.call(fake, { preset: 'ring' });
  assert.deepEqual(fake.state.motion, { clip: 'walk' }, 'a patch still keeps what it does not mention');
  const studio = readFileSync(new URL('../public/lib/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /\n {4}applyMotion\(this, \{ \.\.\.\(s\.motion \|\| \{\}\)/, 'applyModel always re-poses from the bind pose');
  assert.match(studio, /if \(o\.isBone\) o\.userData\.rest = \{ p: o\.position\.clone\(\), q: o\.quaternion\.clone\(\) \}/, 'the bind pose is stored at load');
  const compose = readFileSync(new URL('../public/views/compose.js', import.meta.url), 'utf8');
  assert.match(compose, /studio\.setState\(scene, \{ replace: true \}\)/);
  assert.match(compose, /const snap = \(\) => \(\{ scene, version: m\.activeVersion \}\)/);
  assert.match(compose, /if \(t\.dataset\.act === 'undo'\) return stepHistory\(false\)/, "Pose by hand's Undo button is wired");
  assert.match(compose, /run: async \(\) => \{\n {4}undoRender\(\);\n {4}await stepHistory\(false\);/, "the toast's Undo is the same history as Ctrl+Z");
  assert.doesNotMatch(compose, /Undo reset/);
});

test('renders wait while a model is being rigged, with a plain Rigging… light', () => {
  const rigging = new Set(['m1']);
  const task = (id, status = 'waiting') => ({ status, model: { id } });
  assert.ok(blockedByRig(task('m1'), rigging));
  assert.ok(!blockedByRig(task('m2'), rigging));
  assert.ok(!blockedByRig(task('m1', 'running'), rigging));
  assert.deepEqual(rigLight('Hero', 1), { light: 'busy', pct: 0, text: 'Hero: Rigging… · 1 render waiting', tip: 'Adding joints in Blender. Renders of this model start when it is done' });
  assert.equal(rigLight('Hero').text, 'Hero: Rigging…');
  assert.equal(STATUS_TEXT.rigging, 'Waits for joints');
  const render = readFileSync(new URL('../public/views/compose-render.js', import.meta.url), 'utf8');
  assert.match(render, /if \(blockedByRig\(t, rigs\(\)\)\) \{ renderBar\(\); return; \}/, 'the queue holds the render back');
});

test('the test pose turns the body the way the hero landing does', () => {
  assert.deepEqual(Object.keys(TEST_POSE).sort(), ['Head', 'LeftArm', 'LeftForeArm', 'LeftLeg', 'LeftUpLeg', 'RightArm', 'RightForeArm', 'RightLeg', 'RightUpLeg', 'Spine']);
});
