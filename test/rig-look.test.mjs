// Test Rig Look panel and controls: settings go to the scene and come back, presets apply, the game waits while
// the panel is open, keycaps light while held, the How to play card is remembered, and the climb hint shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIG_ENVS, RIG_LIGHTS, DEFAULT_ENV, GLOW, rigLookOf, lookChange, sunAt, timeOf, timeLabel } from '../public/lib/rig-look.js';
import { KEYCAPS, capLit, keyRoute, showHowTo, rememberHowTo, contextPrompt } from '../public/lib/testrig-ui.js';
import { ENVIRONMENTS } from '../public/lib/environments.js';
import { mergeLook, LIGHT_PRESETS, DEFAULT_LOOK } from '../public/lib/look.js';
import { newPlayer, TUNE } from '../public/lib/testrig.js';

const defaultSceneData = () => ({ preset: 'white-cyc-studio', look: null });
const apply = (scene, key, value) => ({ ...scene, ...lookChange(scene, key, value) });

test('every 3D world is a place to play, White studio first and the default', () => {
  assert.deepEqual(Object.keys(RIG_ENVS), Object.keys(ENVIRONMENTS));
  assert.equal(Object.keys(RIG_ENVS)[0], 'white-cyc-studio');
  assert.equal(DEFAULT_ENV, 'white-cyc-studio');
  assert.equal(rigLookOf({ preset: 'ring' }).env, DEFAULT_ENV); // not a 3D world: plays in White studio
  assert.equal(rigLookOf({ preset: 'showroom' }).env, 'showroom');
});

test('a new scene reads as its own light, nothing switched on', () => {
  const l = rigLookOf(defaultSceneData());
  assert.deepEqual({ light: l.light, fog: l.fog, rain: l.rain, glow: l.glow, brightness: l.brightness }, { light: null, fog: false, rain: false, glow: false, brightness: 1 });
  assert.equal(mergeLook({}).rain, false);
  assert.deepEqual(mergeLook({}).fog, DEFAULT_LOOK.fog);
});

test('every setting round-trips through the scene (and survives saving as JSON)', () => {
  const values = { env: 'night-city-rain', light: 'neon', time: 8.5, brightness: 1.4, rim: '#ff00aa', fog: true, rain: true, glow: true };
  let scene = defaultSceneData();
  for (const [k, v] of Object.entries(values)) {
    scene = JSON.parse(JSON.stringify(apply(scene, k, v)));
    assert.equal(rigLookOf(scene)[k], v, k);
  }
  assert.deepEqual(rigLookOf(scene), values); // later picks never undo earlier ones
  assert.equal(scene.preset, 'night-city-rain');
});

test('each change is one small scene patch: one undo step, nothing else touched', () => {
  const scene = defaultSceneData();
  assert.deepEqual(Object.keys(lookChange(scene, 'env', 'showroom')), ['preset']);
  for (const k of ['light', 'time', 'brightness', 'rim', 'fog', 'rain', 'glow']) assert.deepEqual(Object.keys(lookChange(scene, k, k === 'light' ? 'night' : k === 'rim' ? '#123456' : k === 'time' ? 9 : k === 'brightness' ? 1.2 : true)), ['look'], k);
  const before = JSON.stringify(scene);
  lookChange(scene, 'fog', true);
  assert.equal(JSON.stringify(scene), before, 'the scene itself is not changed');
  const s = apply(scene, 'rain', true);
  assert.deepEqual({ ...mergeLook(s.look), rain: false }, mergeLook(scene.look)); // rain only
  assert.throws(() => lookChange(scene, 'env', 'moon'));
  assert.throws(() => lookChange(scene, 'light', 'disco'));
  assert.throws(() => lookChange(scene, 'sparkles', 1));
});

test('light presets apply their whole look', () => {
  for (const [id, p] of Object.entries(RIG_LIGHTS)) {
    const s = apply(defaultSceneData(), 'light', id);
    const look = mergeLook(s.look), l = rigLookOf(s);
    assert.ok(LIGHT_PRESETS[p.lights], id);
    assert.equal(look.lights.preset, p.lights);
    assert.equal(l.light, id);
    assert.equal(l.time, p.time);
    assert.equal(look.exposure, p.brightness);
    assert.equal(look.lights.rim.color, p.rim);
    assert.equal(look.fog.on, p.fog);
    assert.equal(look.fog.color, p.fogColor);
    assert.equal(look.bloom.on, p.glow);
    if (p.glow) assert.deepEqual({ strength: look.bloom.strength, threshold: look.bloom.threshold }, GLOW, 'glow never washes the model out');
    assert.deepEqual({ azimuth: look.lights.key.azimuth, elevation: look.lights.key.elevation }, sunAt(p.time));
  }
  assert.deepEqual(Object.values(RIG_LIGHTS).map((p) => p.label), ['Studio', 'Sunset', 'Night', 'Neon']);
  // Rain is yours: a preset keeps it as it was.
  const wet = apply(defaultSceneData(), 'rain', true);
  assert.equal(rigLookOf(apply(wet, 'light', 'studio')).rain, true);
});

test('moving a light first swaps the scene\'s own light for Studio', () => {
  const s = apply(defaultSceneData(), 'time', 17);
  assert.equal(mergeLook(s.look).lights.preset, 'studio');
  assert.equal(rigLookOf(s).time, 17);
  const r = apply(defaultSceneData(), 'rim', '#00ff00');
  assert.equal(mergeLook(r.look).lights.rim.color, '#00ff00');
  assert.equal(mergeLook(r.look).lights.rim.on, true);
});

test('time of day: low sun at the ends, highest at noon, read back from where the sun is', () => {
  assert.ok(sunAt(12).elevation > sunAt(8).elevation && sunAt(8).elevation > sunAt(6).elevation);
  assert.ok(sunAt(6).elevation >= 4 && sunAt(20).elevation >= 4);
  for (const h of [6, 9.5, 12, 15, 20]) assert.equal(timeOf(sunAt(h).azimuth), h);
  assert.equal(sunAt(30).azimuth, sunAt(20).azimuth); // clamped
  assert.deepEqual([6, 12, 13, 20].map(timeLabel), ['6 am', 'Noon', '1 pm', '8 pm']);
  assert.equal(rigLookOf(apply(defaultSceneData(), 'brightness', 9)).brightness, 2); // clamped
});

test('game input pauses while the Look panel is open, and comes back when it closes', () => {
  for (const key of ['w', 'a', 's', 'd', ' ', 'Shift', 'q', '?']) {
    assert.equal(keyRoute(key, { panelOpen: false }), 'game', key);
    assert.equal(keyRoute(key, { panelOpen: true }), 'panel', key); // WASD go to the panel's controls, not the game
  }
  assert.equal(keyRoute('Escape', { panelOpen: true }), 'close');
  assert.equal(keyRoute('Escape', { panelOpen: false }), 'game');
  assert.equal(keyRoute('F5', { panelOpen: false }), 'pass');
  assert.equal(keyRoute('F12', { panelOpen: true }), 'pass');
});

test('keycaps: W A S D Move, Shift Run, Space Jump and Climb, mouse Look, Esc Leave; lit while held', () => {
  assert.deepEqual(KEYCAPS.map((g) => [g.label, g.caps.map((c) => c[0]).join(' ')]), [
    ['Move', 'W A S D'], ['Run', 'Shift'], ['Jump', 'Space'], ['Climb', 'Space'], ['Look', 'Mouse'], ['Leave', 'Esc'],
  ]);
  const lit = (held) => KEYCAPS.flatMap((g) => g.caps.filter((c) => capLit(c, new Set(held))).map((c) => `${g.label}:${c[0]}`));
  assert.deepEqual(lit([]), []);
  assert.deepEqual(lit(['KeyW', 'ShiftRight']), ['Move:W', 'Run:Shift']);
  assert.deepEqual(lit(['Space']), ['Jump:Space', 'Climb:Space']);
  assert.deepEqual(lit(['Mouse', 'Escape', 'KeyD']), ['Move:D', 'Look:Mouse', 'Leave:Esc']);
  assert.deepEqual(lit(['KeyX']), []);
});

test('How to play shows the first time only, and is remembered', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(showHowTo(storage), true);
  rememberHowTo(storage);
  assert.equal(showHowTo(storage), false);
  assert.equal(showHowTo(undefined), true); // no storage: still shown
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(showHowTo(broken), true);
  assert.doesNotThrow(() => rememberHowTo(broken));
});

test('the climb hint shows facing a climbable block, not in the open or at the tall outer wall', () => {
  const at = (x, z, yaw, more = {}) => ({ ...newPlayer([x, 0, z]), yaw, ...more });
  assert.equal(contextPrompt(at(0, -6, 0)), ''); // the start: nothing right ahead
  assert.equal(contextPrompt(at(6.5, -3.8, 0)), 'Space to climb'); // facing the 1.6 m block (5..8, -3..-1)
  assert.equal(contextPrompt(at(6.5, -3.8, Math.PI)), ''); // back to it
  assert.equal(contextPrompt(at(-10, -0.8, Math.PI)), 'Space to climb'); // the 2.8 m tall ledge
  assert.equal(contextPrompt(at(-9, -12.8, 0)), 'Space, then Space again to climb'); // the 3.5 m high deck needs a second jump
  assert.equal(contextPrompt(at(0, 14.3, 0)), ''); // the 12 m outer wall is not climbable
  assert.equal(contextPrompt(at(6.5, -3.8, 0, { grounded: false, pos: [6.5, 0.5, -3.8] })), 'Keep pushing forward to grab the edge');
  assert.equal(contextPrompt(at(0, 0, 0, { mode: 'wallrun' })), 'Space to jump off the wall');
  assert.equal(contextPrompt(at(6.5, -4, 0, { mode: 'climb' })), '');
  assert.ok(TUNE.reach > 0);
});
