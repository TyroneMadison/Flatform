// Part colors: parts found by touching faces of one paint (tiny bits joined to a neighbour), a color role for each
// (size, body map, paint contrast, glow), twins sharing a role, roles kept through a remake and through rigging, and
// the same colors, glow and pulse reaching Blender (glb-pieces.mjs paintSpec, render/blender_turntable.py).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLES, ROLE_IDS, TEST_COLORS, segmentFaces, groupOrder, mirrorPairs, labelRoles, bodyRegion, middleX, normPoint, rematch,
  applyRoles, setRole, setLocked, savedParts, roleCounts, withTestColors, glowOf, pulseAt, blenderPulse, surfaceArea, rolesOf,
} from '../public/lib/roles.js';
import { groupFaces } from '../public/lib/infer.js';
import { defaultPaint, resolveColors } from '../public/lib/tenno.js';
import { paintSpec, glbPieces } from '../glb-pieces.mjs';
import { robotMesh, robotGlb, BOXES } from './fixtures/robot-mesh.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

// The robot's parts as the page makes them: segmentFaces, then one part per face group (key Body#0@gi).
function robotParts({ colors = true, move = (p) => p, key = 'Body#0', joints = null } = {}) {
  const { body } = robotMesh();
  const pos = Float32Array.from(body.pos, (v, i) => move([body.pos[i - (i % 3)], body.pos[i - (i % 3) + 1], body.pos[i - (i % 3) + 2]])[i % 3]);
  const total = surfaceArea(pos, body.idx) + 0.0024; // plus the visor
  const seg = segmentFaces(pos, body.idx, { colors: colors ? body.faceColors : null, totalArea: total });
  const box = { min: [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k))), max: [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k))) };
  const names = boxNames(seg);
  const parts = groupOrder(seg.labels).map((p, gi) => ({ key: `${key}@${gi}`, name: `Part ${p + 1}`, box: names[p], area: seg.parts[p].area / total, c: seg.parts[p].c, color: seg.parts[p].color, emissive: 0 }));
  const visorC = move([0, 1.77, 0.135]);
  parts.push({ key: key.replace('Body#0', 'Visor#1'), name: 'Visor', box: 'visor', area: 0.0024 / total, c: visorC, color: [0.1, 0.1, 0.1], emissive: 1 });
  const size = Math.hypot(...box.max.map((v, k) => v - box.min[k]));
  return { seg, parts, box, size, center: middleX(joints, box), labels: seg.labels, names: seg.parts.map((_, i) => `Part ${i + 1}`) };
}
const boxNames = (seg) => { const { body } = robotMesh(); return seg.parts.map((_, p) => [...new Set(body.boxOf.filter((_, f) => seg.labels[f] === p))].sort().join('+')); };

test('segmentFaces: loose boxes are parts, crumbs stuck on the chest join it, biggest part first', () => {
  const { body } = robotMesh();
  const seg = segmentFaces(body.pos, body.idx);
  assert.equal(seg.parts.length, 8, 'chest, head, two arms, two legs, two hands');
  assert.deepEqual(boxNames(seg), ['chest+crumb', 'legL', 'legR', 'head', 'armL', 'armR', 'handL', 'handR']);
  assert.equal(seg.parts[0].faces, 12 + 3 * 12, 'the three crumbs (far under 0.4% each) are part of the chest now');
  assert.ok(seg.parts.every((p, i) => !i || p.area <= seg.parts[i - 1].area));
  assert.equal(seg.labels.length, body.idx.length / 3);
  // A bigger MIN_SHARE folds the hands into the arms they touch? They touch nothing, so they join the nearest big part.
  const coarse = segmentFaces(body.pos, body.idx, { minShare: 0.05 });
  assert.equal(coarse.parts.length, 6);
  assert.match(boxNames(coarse).join(' '), /armL\+handL/);
  assert.match(boxNames(coarse).join(' '), /armR\+handR/);
  assert.equal(segmentFaces(body.pos, body.idx, { maxParts: 3 }).parts.length, 3, 'never more than maxParts');
});

test('segmentFaces: one shell is split where its paint changes, and paint speckles join their neighbour', () => {
  // A 40 x 20 grid, all one piece: the left half red, the right half blue, a few lone faces of the wrong colour.
  const W = 40, H = 20, pos = [], idx = [], colors = [];
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) pos.push(x / 10, y / 10, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = y * (W + 1) + x, b = a + 1, c = a + W + 2, d = a + W + 1;
    idx.push(a, b, c, a, c, d);
    const speck = (x === 5 && y === 5) || (x === 30 && y === 12);
    const red = (x < W / 2) !== speck;
    colors.push(...(red ? [0.8, 0.1, 0.1] : [0.1, 0.2, 0.8]), ...(red ? [0.8, 0.1, 0.1] : [0.1, 0.2, 0.8]));
  }
  const seg = segmentFaces(Float32Array.from(pos), Uint32Array.from(idx), { colors: Float32Array.from(colors) });
  assert.equal(seg.parts.length, 2, 'two paints, the two specks joined to the half around them');
  assert.ok(seg.parts.every((p) => p.faces === W * H), 'each half has exactly its own faces');
  assert.ok(seg.parts[0].color[0] > 0.7 !== seg.parts[1].color[0] > 0.7, 'one red part, one blue part');
  assert.equal(segmentFaces(Float32Array.from(pos), Uint32Array.from(idx)).parts.length, 1, 'with no colours it is one part');
});

test('groupOrder is the order infer.js groupFaces makes face groups in (so piece keys @0, @1 … match)', () => {
  const labels = Uint8Array.from([2, 0, 1, 1, 0, 1, 2, 2, 3]);
  const { groups } = groupFaces(Uint32Array.from({ length: labels.length * 3 }, (_, i) => i), [...labels]);
  assert.deepEqual(groupOrder(labels), groups.map((g) => g.label));
  assert.deepEqual(groupOrder(labels), [2, 1, 0, 3]);
});

test('mirror pairing: left and right twins across the middle, nothing on the middle line, sizes must match', () => {
  const { parts, size, center } = robotParts();
  const pairs = mirrorPairs(parts, center, size).map(([i, j]) => [parts[i].box, parts[j].box].sort().join('/')).sort();
  assert.deepEqual(pairs, ['armL/armR', 'handL/handR', 'legL/legR']);
  const p = (x, area) => ({ c: [x, 1, 0], area });
  assert.deepEqual(mirrorPairs([p(0.5, 0.1), p(-0.5, 0.1)], 0, 2), [[0, 1]]);
  assert.deepEqual(mirrorPairs([p(0.5, 0.1), p(-0.5, 0.03)], 0, 2), [], 'one is three times bigger: not twins');
  assert.deepEqual(mirrorPairs([p(0.5, 0.1), p(0.5, 0.1)], 0, 2), [], 'both on the same side');
  assert.deepEqual(mirrorPairs([p(0.01, 0.1), p(-0.01, 0.1)], 0, 2), [], 'on the middle line');
  assert.deepEqual(mirrorPairs([p(0.5, 0.1), p(-0.3, 0.1)], 0, 2), [], 'not across from each other');
  assert.deepEqual(mirrorPairs([p(1.5, 0.1), p(0.5, 0.1)], 1, 2), [[0, 1]], 'the middle can be off zero');
});

test('labelling rules: size, twins, small trim and glow (a plain model with no paint)', () => {
  const r = robotParts({ colors: false });
  const roles = labelRoles(r.parts.map((p) => ({ ...p, color: null })), { center: r.center, size: r.size });
  const by = Object.fromEntries(r.parts.map((p) => [p.box, roles[p.key]]));
  assert.deepEqual(by, { 'chest+crumb': 'primary', legL: 'secondary', legR: 'secondary', head: 'tertiary', armL: 'tertiary', armR: 'tertiary', handL: 'accents', handR: 'accents', visor: 'energy' });
  for (const [a, b] of [['legL', 'legR'], ['armL', 'armR'], ['handL', 'handR']]) assert.equal(by[a], by[b], `${a} and ${b} share a role`);
});

test('labelling rules: paint contrast (biggest paint is Primary, a small bright paint is Accent) and the body map', () => {
  const r = robotParts();
  const name = (k) => r.parts.find((p) => p.key === k).box;
  const roles = labelRoles(r.parts, { center: r.center, size: r.size });
  const by = Object.fromEntries(Object.entries(roles).map(([k, v]) => [name(k), v]));
  // dark arms and legs (50% of the surface) beat the light chest and head (47%); the gold hands stand out
  assert.deepEqual(by, { legL: 'primary', legR: 'primary', armL: 'primary', armR: 'primary', 'chest+crumb': 'secondary', head: 'secondary', handL: 'accents', handR: 'accents', visor: 'energy' });
  // With joints, the chest is the body's core and counts a quarter more: now the light paint is Primary.
  const joints = [{ name: 'Hips', p: [0, 0.9, 0] }, { name: 'Spine2', p: [0, 1.3, 0] }, { name: 'Head', p: [0, 1.75, 0] }, { name: 'LeftArm', p: [0.45, 1.3, 0] }, { name: 'RightArm', p: [-0.45, 1.3, 0] },
    { name: 'LeftHand', p: [0.45, 0.88, 0] }, { name: 'RightHand', p: [-0.45, 0.88, 0] }, { name: 'LeftLeg', p: [0.15, 0.45, 0] }, { name: 'RightLeg', p: [-0.15, 0.45, 0] }];
  assert.equal(bodyRegion([0, 1.2, 0], joints), 'core');
  assert.equal(bodyRegion([0.45, 0.9, 0], joints), 'hand');
  assert.equal(bodyRegion([0, 1.8, 0], joints), 'head');
  assert.equal(middleX(joints, { min: [-5, 0, 0], max: [1, 0, 0] }), 0, 'the hips are the middle, not the box');
  const withJoints = labelRoles(r.parts, { center: 0, size: r.size, joints });
  const byJ = Object.fromEntries(Object.entries(withJoints).map(([k, v]) => [name(k), v]));
  assert.deepEqual([byJ['chest+crumb'], byJ.head, byJ.legL, byJ.armR], ['primary', 'primary', 'secondary', 'secondary']);
});

test('labelling rules: glow from the part itself, Energy for small hard glow, neon trim glows, locked parts and their twins keep their role', () => {
  const part = (key, x, area, extra = {}) => ({ key, c: [x, 1, 0], area, color: [0.5, 0.5, 0.5], emissive: 0, ...extra });
  const roles = labelRoles([
    part('body', 0, 0.8), part('soft', 0.2, 0.08, { emissive: 0.4 }), part('core', 0, 0.02, { emissive: 0.9 }),
    part('big glow', 0.3, 0.09, { emissive: 0.9 }), part('neon', -0.3, 0.01, { color: [0.1, 1, 0.95] }),
  ], { size: 2 });
  assert.deepEqual(roles, { body: 'primary', soft: 'emissive', core: 'energy', 'big glow': 'emissive', neon: 'emissive' });
  const r = robotParts({ colors: false });
  const legL = r.parts.find((p) => p.box === 'legL'), legR = r.parts.find((p) => p.box === 'legR');
  const locked = labelRoles(r.parts, { center: r.center, size: r.size, locked: { [legL.key]: 'accents' } });
  assert.equal(locked[legL.key], 'accents');
  assert.equal(locked[legR.key], 'accents', 'the twin of a locked part keeps the same role');
});

test('save and restore: roles, locks and colors survive a remake (new size, place and keys) and rigging', () => {
  const first = robotParts();
  const roles = labelRoles(first.parts, { center: first.center, size: first.size });
  const parts = first.parts.map((p) => ({ key: p.key, name: p.name, c: normPoint(p.c, first.box), a: p.area, role: roles[p.key], locked: false }));
  let paint = applyRoles(defaultPaint(), { parts, groups: { 'Body#0': { labels: 'x', names: first.names } }, meshes: ['Body#0'], sig: 'v1', colors: { primary: '#223344' } });
  assert.equal(paint.colors.global.primary, '#223344', 'the first guess seeds the role colors');
  assert.ok(paint.roles.guessed);
  assert.equal(roleCounts(paint).primary, 4);
  // The user picks Energy for the head by hand: that part is now locked.
  const head = first.parts.find((p) => p.box === 'head').key;
  paint = setRole(paint, head, 'energy');
  assert.equal(paint.roles.parts[head].locked, true);
  paint = { ...paint, colors: { ...paint.colors, global: { ...paint.colors.global, energy: '#18f0ff' } } };
  const before = Object.fromEntries(first.parts.map((p) => [p.key, paint.pieces[p.key].slot]));

  // Made again: 1.3 times bigger, moved, a new mesh name and index. Every part finds its old self by place and size.
  const again = robotParts({ move: ([x, y, z]) => [x * 1.3 + 2, y * 1.3 + 0.5, z * 1.3 - 1], key: 'Robot#0' });
  const fresh = again.parts.map((p) => ({ key: p.key, c: normPoint(p.c, again.box), a: p.area }));
  const kept = rematch(savedParts(paint), fresh);
  assert.equal(Object.keys(kept).length, again.parts.length, 'every new part matched an old one');
  const relabel = labelRoles(again.parts, { center: again.center, size: again.size, locked: Object.fromEntries(Object.entries(kept).map(([k, x]) => [k, x.role])) });
  const next = applyRoles(paint, {
    parts: again.parts.map((p, i) => ({ key: p.key, name: p.name, c: fresh[i].c, a: p.area, role: relabel[p.key], locked: kept[p.key].locked })),
    groups: { 'Robot#0': { labels: 'y', names: again.names } }, meshes: ['Robot#0'], sig: 'v2',
  });
  for (const [i, p] of again.parts.entries()) assert.equal(next.pieces[p.key].slot, before[first.parts[i].key], `${p.name} keeps its role`);
  assert.equal(next.roles.parts[head.replace('Body#0', 'Robot#0')].locked, true, 'the lock comes along');
  assert.equal(next.colors.global.energy, '#18f0ff', 'role colors are the model\'s, not the parts\'');
  assert.equal(next.colors.global.primary, '#223344');
  assert.deepEqual(Object.keys(next.groups), ['Robot#0'], 'the old face groups are gone, the new ones are in');
  assert.ok(!Object.keys(next.pieces).some((k) => k.startsWith('Body#0')), 'old part records are dropped');

  // Rigged: Blender adds an armature, the mesh moves to index 1 under a new name; the shape itself is the same.
  const rigged = robotParts({ key: 'Armature_Robot#1' });
  const rf = rigged.parts.map((p) => ({ key: p.key, c: normPoint(p.c, rigged.box), a: p.area }));
  const k2 = rematch(savedParts(next), rf);
  for (const [i, p] of rigged.parts.entries()) assert.equal(k2[p.key].role, before[first.parts[i].key], `${p.name} keeps its role after rigging`);

  // Something new where nothing was (a cape): no match, it gets a fresh guess.
  assert.deepEqual(rematch(savedParts(next), [{ key: 'cape', c: [0.5, 0.5, 0.9], a: 0.1 }]), {});
  assert.deepEqual(rematch(savedParts(next), [{ key: 'tiny', c: fresh[0].c, a: fresh[0].a / 10 }]), {}, 'same place, far too small: not the same part');
  // Unlock.
  assert.equal(setLocked(next, head.replace('Body#0', 'Robot#0'), false).roles.parts[head.replace('Body#0', 'Robot#0')].locked, undefined);
});

test('save and restore: Part colors go through the server with the scene and come back the same', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-roles-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const form = new FormData();
    form.append('glb', new Blob([robotGlb()]), 'robot.glb');
    form.append('name', 'Robot');
    const m = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const paint = setRole(applyRoles(defaultPaint(), { parts: [{ key: 'Visor#1', name: 'Visor', c: [0.5, 0.9, 0.6], a: 0.01, role: 'emissive', locked: false }], sig: 's' }), 'Visor#1', 'energy');
    paint.roles = { ...paint.roles, pulse: 1.5, strength: { emissive: 2, energy: 6 } };
    const res = await fetch(`${base}/api/models/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: { paint } }) });
    assert.equal(res.status, 200);
    const back = await (await fetch(`${base}/api/models/${m.id}`)).json();
    assert.deepEqual(back.scene.paint.roles, paint.roles);
    assert.equal(back.scene.paint.pieces['Visor#1'].slot, 'energy');
  } finally { await app.close(); }
});

test('Blender material mapping: every part gets its role color, Glow and Energy their strength, Energy its pulse, groups by node', () => {
  const r = robotParts();
  const roles = labelRoles(r.parts, { center: r.center, size: r.size });
  const labels = Buffer.from(r.labels).toString('base64');
  let paint = applyRoles(defaultPaint(), {
    parts: r.parts.map((p) => ({ key: p.key, name: p.name, c: normPoint(p.c, r.box), a: p.area, role: roles[p.key] })),
    groups: { 'Body#0': { labels, names: r.names } }, meshes: ['Body#0'], sig: 's',
    colors: { primary: '#204060', secondary: '#c0c0c0', accents: '#ffaa00', energy: '#00ffee' },
  });
  paint = { ...paint, roles: { ...paint.roles, pulse: 0.5, strength: { emissive: 2.5, energy: 7 } } };
  const glb = robotGlb();
  const spec = paintSpec(paint, () => glb);
  assert.deepEqual(glbPieces(glb).map((p) => p.node), ['Body', 'Visor']);
  assert.equal(spec.groups['Body#0'].node, 'Body', 'Blender finds the face groups by node name');
  assert.equal(spec.groups['Body#0'].labels, labels);
  for (const p of r.parts.filter((x) => x.key.startsWith('Body'))) {
    assert.equal(spec.materials[p.key].base_color, resolveColors(paint, paint.pieces[p.key])[roles[p.key]], `${p.name}: its role's color`);
    assert.equal(spec.materials[p.key].slot, roles[p.key]);
    assert.equal(spec.materials[p.key].node, undefined, 'a face group keeps its key (Body#0@gi)');
  }
  const visor = spec.materials['Visor#1'];
  assert.deepEqual([visor.node, visor.slot, visor.emission_color, visor.emission_strength], ['Visor', 'energy', '#00ffee', 7]);
  assert.deepEqual(visor.pulse, { strength: 7, speed: 0.5 });
  // Glow: its strength, no pulse. A model without Part colors keeps the old glow (at least 2).
  const glow = paintSpec({ ...paint, pieces: { ...paint.pieces, 'Visor#1': { ...paint.pieces['Visor#1'], slot: 'emissive' } } }, () => glb).materials['Visor#1'];
  assert.deepEqual([glow.emission_strength, glow.pulse], [2.5, undefined]);
  const old = paintSpec({ ...defaultPaint(), pieces: { 'Visor#1': { slot: 'emissive' } } }, () => glb).materials['Visor#1'];
  assert.deepEqual([old.emission_strength, old.pulse], [2, undefined]);
  assert.equal(glowOf(defaultPaint(), 'emissive'), null);
  assert.equal(blenderPulse({ ...paint, roles: { ...paint.roles, pulse: 0 } }, 'energy'), null, 'pulse speed 0: a steady glow');
  // The pulse is one formula in both places: full at t = 0, 30% at the low point, steady at speed 0.
  assert.equal(pulseAt(10, 0.5, 0), 10);
  assert.ok(Math.abs(pulseAt(10, 0.5, 1) - 3) < 1e-9);
  assert.equal(pulseAt(10, 0, 0.7), 10);
  const py = read('render/blender_turntable.py');
  assert.match(py, /return strength \* \(0\.65 \+ 0\.35 \* math\.cos\(2 \* math\.pi \* speed \* t\)\) if speed > 0 else strength/);
  assert.match(read('public/lib/roles.js'), /strength \* \(0\.65 \+ 0\.35 \* Math\.cos\(2 \* Math\.PI \* speed \* t\)\) : strength/);
  assert.match(py, /set_pulse\(i\)\n\s+render_to\(/, 'every turntable frame sets the pulse first');
  assert.match(py, /next\(\(o for o in meshes if base_name\(o\.name\) == g\["node"\]\), None\) if g\.get\("node"\)/);
  assert.match(py, /piece = materials\.get\(f"\{gkey\}@\{gi\}"\)/);
  assert.match(read('server.mjs'), /await writeAtomic\(materialsFile, materialsSpec\);/);
});

test('test colors: bright and flat (no texture under them), only on parts with a role, not saved', () => {
  const paint = { ...defaultPaint(), pieces: { a: { slot: 'primary', colors: { primary: '#000000' }, material: { textured: true, color: '#111111' } }, b: { name: 'no role' } }, roles: { parts: {} } };
  const t = withTestColors(paint);
  assert.deepEqual(resolveColors(t, t.pieces.a).primary, TEST_COLORS.primary);
  assert.equal(t.pieces.a.material.textured, false);
  assert.equal(t.pieces.a.material.color, null);
  assert.equal(t.pieces.b, paint.pieces.b);
  assert.equal(new Set(Object.values(TEST_COLORS)).size, 6, 'six different test colors');
  assert.deepEqual(Object.keys(TEST_COLORS), ROLE_IDS);
  assert.match(read('public/lib/studio.js'), /this\.testColors && this\.state\.paint \? withTestColors\(this\.state\.paint\) : this\.state\.paint/);
  assert.equal(rolesOf(null).pulse, 0.5, 'a slow pulse by default');
});

test('Part colors UI: Find the parts, one picker per role, the card, the role chips and lock, plain words, tips, 44px', () => {
  const ui = read('public/views/compose-roles.js');
  const compose = read('public/views/compose.js');
  assert.deepEqual(ROLES.map((r) => r.label), ['Primary', 'Secondary', 'Tertiary', 'Accent', 'Glow', 'Energy']);
  assert.match(ui, />We guessed the parts\. Click one to change it\.</);
  assert.match(ui, /data-roles="done" title="[^"]+">Looks good</);
  assert.match(ui, /data-roles="guess" title="[^"]+"[^>]*>\$\{busy \? 'Finding the parts…' : 'Find the parts'\}/);
  assert.match(ui, /new ColorPicker\(box, \{/, 'the same color wheel as Color');
  assert.match(ui, /'Glow strength'/);
  assert.match(ui, /'Energy strength'/);
  assert.match(ui, /'Pulse speed'/);
  assert.match(ui, /data-role-set="\$\{x\.id\}"[^>]*title="[^"]+"/);
  assert.match(ui, /title="Guess again leaves this part's role as it is"><span>Lock this role/);
  assert.match(ui, /new Worker\(new URL\('\.\.\/lib\/roles-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  for (const tag of ui.match(/<(button|input)\b[^>]*>/g)) assert.match(tag, /title="/, `every control has a tip: ${tag.slice(0, 60)}`);
  assert.match(compose, /\$\{renderRolesGroup\(\)\}\$\{renderPaintGroups\(\)\}/);
  assert.match(compose, /<div class="trimcard rolecard" id="roleCard" role="status" hidden>\$\{roleCardHtml\(\)\}<\/div>/);
  assert.match(compose, /await checkRoles\(\); \/\/ Part colors: a changed model/);
  assert.match(compose, /if \(await onRolesClick\(t\)\) return;/);
  assert.match(read('public/lib/stage.js'), /look: \['grp-roles', 'grp-role',/);
  const css = read('public/styles/stage.css');
  assert.match(css, /\.rolerow \{[^}]*min-height: 44px;/);
  assert.match(css, /\.rolechips \.chip \{ min-height: 44px;/);
  for (const f of ['public/views/compose-roles.js', 'public/lib/roles.js', 'public/lib/roles-worker.js', 'glb-pieces.mjs', 'test/roles.test.mjs']) {
    assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)), `${f}: no em dashes`);
  }
  assert.ok(BOXES.length === 11);
});
