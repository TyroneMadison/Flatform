// v3 "Stage" UI: the step trail, the tool dock and its groups, sheets, Render ideas, and the shell's
// grandma rules (tooltips on every button, 44 px targets, no horizontal scroll, plain words).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STEPS, stepOf, journey, isSheet, dockFor, DEFAULT_TOOL, SCENE_GROUPS, shows, TOOL_TIPS, changeName, ringDash } from '../public/lib/stage.js';
import { IDEAS, ideasFor, applyIdea } from '../public/lib/render-ideas.js';
import { ENVIRONMENTS } from '../public/lib/environments.js';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles/stage.css');
const app = read('app.js');
const compose = read('views/compose.js');
const views = readdirSync(new URL('../public/views/', import.meta.url)).map((f) => read(`views/${f}`)).join('\n');

test('step trail: Photo > 3D model > Scene and render > Finish, finished steps ticked', () => {
  assert.deepEqual(STEPS.map((s) => s.label), ['Photo', '3D model', 'Scene and render', 'Finish']);
  assert.equal(stepOf('drop'), 'photo');
  assert.equal(stepOf('setup'), 'model');
  assert.equal(stepOf('generate'), 'model');
  assert.equal(stepOf('compose'), 'scene');
  assert.equal(stepOf('finish'), 'finish');
  assert.equal(stepOf('library'), null, 'a sheet is not a step');
  const j = journey('compose', { scene: '#/compose/a' });
  assert.deepEqual(j.map((s) => s.state), ['done', 'done', 'current', 'todo']);
  assert.equal(j[2].href, '#/compose/a');
  assert.deepEqual(journey('library').map((s) => s.state), ['todo', 'todo', 'todo', 'todo']);
  for (const s of STEPS) assert.ok(s.tip.length > 10, `${s.id} has a tooltip`);
  assert.doesNotMatch(app, /\['render', 'Render'\]/, 'there is no Render step: rendering is inside Scene');
});

test('sheets: Library, Settings, Share and Usage open over the stage; ✕ and Esc go back to the step', () => {
  for (const s of ['library', 'model', 'settings', 'share', 'history', 'usage', 'test']) assert.ok(isSheet(s), s);
  for (const s of ['drop', 'compose', 'finish', 'preview']) assert.ok(!isSheet(s), s);
  assert.match(app, /e\.key !== 'Escape' \|\| !isSheet\(route\.name\)/);
  assert.match(app, /export const closeSheet = \(\) => go\(lastStep\)/);
  assert.match(html, /id="sheetClose"[^>]*title="Close and go back \(Esc\)"/);
});

test('dock: Scene tools in order; cars get Car parts and no pose, characters get Pose with the Test Rig', () => {
  const car = dockFor('scene').map((t) => t[0]);
  assert.deepEqual(car, ['world', 'look', 'light', 'camera', 'carparts', 'tools', 'render']);
  const person = dockFor('scene', { humanoid: true }).map((t) => t[0]);
  assert.deepEqual(person, ['world', 'look', 'light', 'camera', 'pose', 'tools', 'render']);
  assert.ok(!SCENE_GROUPS.carparts.includes('grp-testrig') && !SCENE_GROUPS.carparts.includes('grp-handpose'), 'no pose controls for cars');
  assert.ok(SCENE_GROUPS.pose.includes('grp-testrig') && SCENE_GROUPS.pose.includes('grp-handpose'), 'Test Rig and Pose by hand under Pose');
  assert.deepEqual(dockFor('model').map((t) => t[0]), ['recipe', 'photos']);
  assert.deepEqual(dockFor('finish').map((t) => t[0]), ['check', 'compare', 'history', 'share']);
  assert.deepEqual(dockFor('photo'), [], 'Photo has one big drop area and no dock');
  for (const step of ['scene', 'model', 'finish']) {
    assert.ok(dockFor(step).some((t) => t[0] === DEFAULT_TOOL[step]), step);
    for (const [, ic, label, tip] of dockFor(step, { humanoid: true })) { assert.ok(ic && label && tip.length > 10, label); assert.match(read('lib/icons.js'), new RegExp(`\\b${ic}: '`), ic); }
  }
  for (const [id] of dockFor('scene', { humanoid: true })) assert.ok(TOOL_TIPS[id]?.length > 20, `${id} says what to do`);
});

test('dock groups: every group on the Scene screen belongs to a tool, so nothing built earlier goes missing', () => {
  const ids = new Set([...views.matchAll(/(?:class="grp[^"]*" id|id)="(grp-[a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(ids.size >= 18, `found ${ids.size} groups`);
  const placed = new Set(Object.values(SCENE_GROUPS).flat());
  for (const id of ids) assert.ok(placed.has(id), `${id} has a dock tool`);
  for (const id of placed) assert.match(views, new RegExp(`id="${id}"`), `${id} exists on screen`);
  assert.ok(shows('render', 'renderArea') && !shows('world', 'renderArea'));
  assert.ok(shows('look', 'grp-color') && !shows('light', 'grp-color'));
  assert.ok(shows('camera', 'something-new'), 'unknown ids always show');
  assert.ok(SCENE_GROUPS.tools.includes('startover'), 'Reset scene and Restore last session are in Tools');
  assert.match(compose, /id="startover"[\s\S]*data-act="reset-scene"[\s\S]*data-act="restore-session"[\s\S]*data-act="versions"/);
});

test('every keyboard shortcut still has its button on screen', () => {
  const sc = read('lib/shortcuts.js');
  for (const [, sel] of sc.matchAll(/click: '([^']+)'/g)) {
    const needle = sel.startsWith('#') ? `id="${sel.slice(1)}"` : sel.slice(1, -1);
    assert.ok(views.includes(needle) || html.includes(needle), `${sel} is somewhere to press`);
  }
  assert.match(read('lib/hotkeys.js'), /#top \$\{sel\}/, 'shortcuts can press the top bar Undo and Redo');
});

test('inspector card: clicking a part opens its colour and material on the right', () => {
  assert.match(compose, /<aside class="icard card" id="insp"[^>]*hidden>/);
  assert.match(compose, /inspOpen = true; selectPiece\(key\)/);
  assert.match(compose, /for \(const id of \['grp-color', 'grp-material'\]\)/);
  assert.match(compose, /data-act="insp-close" title="/);
});

test('undo pill: an edit says "X changed · Undo", an undo says "X undone · Redo", and it fades by itself', () => {
  assert.equal(changeName(['preset']), 'World');
  assert.equal(changeName(['paint']), 'Colours');
  assert.equal(changeName(['x', 'y']), 'Position');
  assert.equal(changeName(['look', 'paint']), 'Light and look and more');
  assert.equal(changeName(['whatever']), 'Scene');
  assert.equal(changeName([]), 'Scene');
  assert.match(compose, /undoNote\(`\$\{name\} changed`, 'Undo'/);
  assert.match(compose, /\$\{redo \? 'redone' : 'undone'\}/);
  assert.match(compose, /pill\?\.classList\.add\('out'\)[\s\S]{0,80}\}, 4000\)/, 'the pill goes away on its own');
  assert.match(read('styles/stage.css'), /\.toast\.undo \{[^}]*height: 36px/, 'a one-line 36px pill');
});

test('render pill ring: 0 to 100, clamped and rounded', () => {
  assert.equal(ringDash(46.4), '46 100');
  assert.equal(ringDash(-3), '0 100');
  assert.equal(ringDash(140), '100 100');
  assert.equal(ringDash(undefined), '0 100');
});

test('render ideas: each one uses a real world, camera and render option', () => {
  const studio = read('lib/studio.js');
  const cameras = Object.fromEntries([...studio.match(/export const CAMERAS = \{([\s\S]*?)\n\};/)[1].matchAll(/(\w+): \{ label: '[^']+', turn: (\d+), elevation: [\d.]+, lens: (\d+)/g)].map(([, k, turn, lens]) => [k, { turn: +turn, lens: +lens }]));
  assert.deepEqual(Object.keys(cameras), ['front34', 'side', 'rear34', 'low']);
  const worlds = new Set(['cyclorama', 'ring', 'transparent', 'miami', 'custom', ...Object.keys(ENVIRONMENTS)]);
  const renderKeys = new Set(['still', 't360', 't180', 'showroom', 'studio', 'transparent']);
  assert.ok(IDEAS.length >= 8);
  assert.equal(new Set(IDEAS.map((i) => i.id)).size, IDEAS.length, 'ids are unique');
  for (const idea of IDEAS) {
    assert.ok(idea.label && idea.desc.length > 15 && idea.art, idea.id);
    const r = applyIdea(idea.id, cameras);
    if (idea.go) { assert.equal(r.go, 'finish'); continue; }
    if (r.scene.preset) assert.ok(worlds.has(r.scene.preset), `${idea.id}: ${r.scene.preset} is a world`);
    if (r.scene.camera) { assert.ok(cameras[r.scene.camera], idea.id); assert.equal(r.scene.turn, cameras[r.scene.camera].turn); assert.equal(r.scene.lens, cameras[r.scene.camera].lens); }
    for (const k of Object.keys(r.render)) assert.ok(renderKeys.has(k), `${idea.id}: ${k}`);
    assert.ok(r.render.still || r.render.t360 || r.render.t180, `${idea.id} renders something`);
    assert.ok(r.render.showroom || r.render.studio || r.render.transparent, `${idea.id} has a look`);
    assert.ok(['picture', 'spin'].includes(r.type), `${idea.id} picks a render type`);
  }
  // The gallery matches the v3 mock-up: its eight ideas, in its order, come first.
  assert.deepEqual(IDEAS.slice(0, 8).map((i) => i.label), ['Hero poster', 'Dud Rents listing set', 'Photo vs 3D', 'Exploded parts', 'In-game Warframe shot', 'Phone spin 9:16', 'Night neon', 'Clay or blueprint']);
  assert.deepEqual(applyIdea('explode', cameras).extras, { effect: { explode: 0.15 } });
  assert.deepEqual(applyIdea('clay', cameras).extras, { effect: { override: 'clay' } });
  assert.deepEqual(applyIdea('vertical', cameras).extras, { vertical: true });
  assert.deepEqual(applyIdea('hero', cameras).extras, { poster: '' });
  const a = applyIdea('clay', cameras); a.extras.effect.override = 'blueprint';
  assert.equal(applyIdea('clay', cameras).extras.effect.override, 'clay', 'an idea hands out a copy');
  assert.ok(!ideasFor('car').some((i) => i.warframe), 'the Warframe shot is only in Warframe mode');
  assert.ok(ideasFor('warframe').some((i) => i.id === 'ingame'));
  assert.equal(applyIdea('nope'), null);
  assert.deepEqual(applyIdea('hero', cameras).scene, { camera: 'low', turn: 30, lens: 35, view: 'car', fit: 'footprint' });
  // The gallery is in the Render tool, and nothing starts until Render is pressed.
  assert.match(compose, /data-idea="\$\{i\.id\}" title="\$\{esc\(i\.desc\)\}"/);
  assert.match(compose, /pickRender\(r\.render, r\)/);
  assert.match(read('views/compose-render.js'), /export function pickRender\(patch, idea = \{\}\)/);
});

test('top bar: every v3 control is there, with a tooltip', () => {
  const bar = html.match(/<header class="topbar"[\s\S]*?<\/header>/)[0];
  for (const id of ['wsPill', 'modeSeg', 'undoBtn', 'redoBtn', 'savedNote', 'renderLight', 'accountStatus', 'blenderLight', 'searchBtn', 'libraryBtn', 'shareBtn', 'presentBtn', 'settingsBtn', 'appVersion']) assert.match(bar, new RegExp(`id="${id}"`), id);
  for (const label of ['Car', 'Warframe', 'Undo', 'Redo', 'Saved', 'Nothing rendering', 'Tripo', 'Blender · GPU', 'Search', 'Library', 'Share', 'Show a client']) assert.ok(bar.includes(`>${label}<`), label);
  for (const tag of html.match(/<(button|a)\b[^>]*>/g)) assert.match(tag, /title="/, tag);
  assert.match(html, /Where do I find this\?/, 'the key dialog explains where the key comes from');
  assert.doesNotMatch(html, /API key/, 'no jargon in the shell');
  for (const id of ['dock', 'journey', 'queueTray', 'toasts', 'sheetClose']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /styles\/stage\.css/);
});

test('styles: 44 px targets, no horizontal scroll, the motion tokens, reduced motion', () => {
  const rule = css.match(/^\.btn, [^{]*\{ min-height: 44px; \}/m)?.[0] || '';
  for (const sel of ['.btn', '.btn.sm', '.chip', 'select.inp', '.link', 'summary', '.swatch', '.sn a', '.tg']) assert.ok(rule.includes(sel), sel);
  assert.match(css, /\.btn\.icon, \.btn\.xs, \.btn\.icon\.xs, \.vt \{ min-width: 44px; min-height: 44px; \}/);
  for (const sel of ['.tb-btn, .tb-pill, .tb-dot, .tb-seg button, .wsbtn', '.jstep', '.dk']) assert.match(css, new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*min-height: (44|60)px`), sel);
  assert.match(css, /html, body, \.win \{ overflow-x: hidden; max-width: 100vw; \}/);
  assert.match(css, /#view\.content \{[^}]*overflow-x: hidden/);
  for (const t of ['--d1: 120ms', '--d2: 200ms', '--d3: 320ms', '--d4: 480ms', '--out: cubic-bezier(.2, .8, .2, 1)', '--spring: cubic-bezier(.34, 1.56, .64, 1)']) assert.ok(css.includes(t), t);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /body\.rm \*/);
  assert.match(read('views/settings.js'), /id="reduceMotion"/, 'Settings > Look > Reduce motion');
  assert.match(css, /@keyframes breathe/, 'the drop area breathes');
  assert.match(css, /@keyframes rpulse/, 'the viewport outline pulses while rendering');
  assert.match(css, /\.tcheck \{[^}]*animation: draw var\(--d4\)/, 'the success check draws itself');
});

test('plain words: settings tabs, the Photo step, the render pill and the mode switch', () => {
  const tabs = read('views/settings.js').match(/const SECTIONS = \[(.*)\];/)[1];
  for (const t of ['Accounts', 'Look', 'Rendering', 'Folders', 'Version history', 'Usage', 'About and updates']) assert.ok(tabs.includes(`'${t}'`), t);
  const drop = read('views/drop.js');
  assert.match(drop, /Drop a photo\. Get a 3D car\./);
  assert.match(drop, /Drop a picture\. Get a 3D Warframe\./);
  assert.match(drop, /From template/);
  assert.match(drop, />Choose photos</);
  assert.match(app, /localStorage\.setItem\('flatform\.mode', mode\)/);
  assert.match(app, /'✓ Render done · Flatform'/, 'the window title says when a render is done');
  assert.match(app, /new Notification\('Flatform: render finished', \{ body: l\.text, silent: true \}\)/);
  for (const c of ['Go to Photo', 'Go to Scene and render', 'Restore last session', 'Show a client', 'Show render queue', 'Library: renders', 'Usage and spend']) assert.ok(app.includes(`'${c}'`), `Ctrl+K: ${c}`);
});
