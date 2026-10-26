// Compose, Test rig (humanoids with a skeleton only): play the character in a small arena of blocks to see the rig
// move. It runs on its own canvas over Compose with a copy of the model. Only the Look panel changes the Compose
// scene (lib/rig-look.js: place, light, fog, rain, glow), one undo step per change; leaving just removes the overlay. Movement and poses live in lib/testrig.js, the bone work in lib/testrig-rig.js.
// The picture uses the main scene's pipeline (post.js): sky-picture light and reflections, corner shading, soft
// shadows, tone mapping, subsurface on skin and cloth and the toned-down glow, at Fast or High (lib/rig-quality.js).
// Photo (P) pauses and lets the path tracer build up a ray-traced picture of the frame; any key plays on.
import * as THREE from 'three';
import { keyOf } from '../lib/shortcuts.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { esc, toast } from '../app.js';
import { mapBones } from '../lib/motion.js';
import { modelInfo } from '../lib/rig.js';
import { canPoseByHand } from '../lib/handpose.js';
import { ARENA, START, TUNE, newPlayer, step, newAnim, stepAnim, poseFor, mixPose, wrapSpin, stateLabel, facingYaw, topAt } from '../lib/testrig.js';
import { makeRig, applyPose } from '../lib/testrig-rig.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Post, PathTraced, TONE } from '../lib/post.js';
import { withSSS } from '../lib/paint.js';
import { ENVIRONMENTS, envParts, partBounds, skyRotation } from '../lib/environments.js';
import { buildEnvironment, buildRain } from '../lib/env3d.js';
import { mergeLook, lightsFromPreset } from '../lib/look.js';
import { RIG_ENVS, RIG_LIGHTS, TIME, rigLookOf, lookChange, sunAt, timeLabel } from '../lib/rig-look.js';
import { KEYCAPS, capLit, keyRoute, showHowTo, rememberHowTo, contextPrompt, testRigGate } from '../lib/testrig-ui.js';
import { QUALITY, qualityOf, saveQuality, rigEffects, materialKind, SSS, lightingHdri, adaptScale, fpsOf, photoLabel } from '../lib/rig-quality.js';

let ctx; // same ctx as compose-motion
let run = null; // the live session, or null

export function initTestRig(c) { ctx = c; stopTestRig(); } // { scene, studio, change, draw }

const isPerson = () => { const s = ctx?.studio(); return Boolean(s?.model) && (ctx.model?.()?.kind ? ctx.model().kind === 'humanoid' : modelInfo(s, ctx.scene().motion?.type || 'auto').type === 'humanoid'); };
function available() {
  const s = ctx?.studio();
  if (!isPerson()) return false;
  const names = [];
  s.model.traverse((o) => { if (o.isBone) names.push(o.name); });
  return canPoseByHand(mapBones(names));
}

const opts = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
const PLACE_TIP = 'The place your character stands in. It is the same world as your scene.';
const LIGHT_TIP = 'A ready-made light: Studio, Sunset, Night or Neon. It sets the time of day, brightness, edge light, fog and glow.';

export function renderTestRigGroup() {
  const gate = testRigGate({ humanoid: isPerson(), rigged: available() });
  if (!gate.show) return '';
  if (!gate.enabled) {
    return `<div class="grp" id="grp-testrig"><h3>Test rig</h3>
    <button class="btn sec" type="button" data-tr="start" data-none="${esc(gate.hint)}" disabled title="${esc(gate.hint)} (${keyOf('testrig')})">Test Rig (${keyOf('testrig')})</button>
    <p class="fine keep">${esc(gate.hint)}.</p></div>`;
  }
  const l = rigLookOf(ctx.scene());
  return `<div class="grp" id="grp-testrig"><h3>Test rig</h3><p class="fine">Run, jump and climb as this character in a small play area, to see how its joints move.</p>
    <button class="btn pri" type="button" data-tr="start" title="Play as this character in a small play area (${keyOf('testrig')}). Esc comes back.">Test rig</button>
    <div class="tr-lookrow" role="group" aria-label="Look">
      <label class="row-sel" title="${PLACE_TIP}"><span>Place</span><select class="inp" data-tr-look="env" aria-label="Place">${opts(RIG_ENVS, l.env)}</select></label>
      <label class="row-sel" title="${LIGHT_TIP}"><span>Light</span><select class="inp" data-tr-look="light" aria-label="Light">${l.light ? '' : '<option value="" selected>As the scene</option>'}${opts(Object.fromEntries(Object.entries(RIG_LIGHTS).map(([k, p]) => [k, p.label])), l.light)}</select></label>
    </div></div>`;
}
/** The Pose panel's Look row: one scene change (one undo step) per pick. */
export function onTestRigChange(t) {
  const key = t.dataset?.trLook;
  if (!key || !t.value) return false;
  ctx.change(lookChange(ctx.scene(), key, t.value));
  return true;
}
export async function onTestRigClick(t) {
  if (t.dataset.tr !== 'start') return false;
  try { start(); } catch (err) { stopTestRig(); toast(`Test Rig could not start: ${err.message}`); }
  return true;
}

const HOWTO = [
  ['W A S D', 'Move'], ['Mouse', 'Look around'], ['Shift', 'Sprint'], ['Space', 'Jump, press again in the air to jump again'],
  ['Ctrl or C', 'Crouch, or slide when running fast'], ['Ctrl + Space', 'Bullet jump: launch where you look'],
  ['Hold right mouse', 'Glide while falling'], ['Q', 'Roll'], ['Run beside a wall', 'Wall run'], ['Jump at a ledge', 'Climb up'],
  ['R', 'Back to the start'], ['P', 'Pause and make a ray-traced photo, any key plays on'], ['Esc', 'Free the mouse, press again to leave'],
];

function arenaMeshes() {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), new THREE.MeshStandardMaterial({ color: 0x2b2624, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const grid = new THREE.GridHelper(30, 30, 0x4a3d39, 0x3a302d);
  grid.position.y = 0.005;
  floor.userData.plain = grid.userData.plain = true; // hidden inside a 3D place: it has its own floor
  g.add(floor, grid);
  const colors = [0x6b5a52, 0xc96f5c, 0x8f7d72, 0xd9a066];
  ARENA.forEach((s, i) => {
    const [x0, y0, z0] = s.min, [x1, y1, z1] = s.max;
    let geo;
    if (s.rise) { // a wedge: the box with its low edge squashed to the floor
      geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
      const p = geo.attributes.position;
      for (let k = 0; k < p.count; k++) {
        if (p.getY(k) <= 0) continue;
        const h = topAt(s, p.getX(k) + (x0 + x1) / 2, p.getZ(k) + (z0 + z1) / 2) - y0;
        p.setY(k, h - (y1 - y0) / 2);
      }
      geo.computeVertexNormals();
    } else geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    const wall = y1 >= 12;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: wall ? 0x3a3230 : colors[i % colors.length], roughness: 0.8 }));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.castShadow = !wall; mesh.receiveShadow = true;
    mesh.userData.plain = wall; // the outer walls: invisible in a 3D place, but you still bump into them
    g.add(mesh);
  });
  return g;
}

// A copy of the Compose model, standing on its feet at the origin, facing +z, the height the movement expects.
function character(studio) {
  const src = studio.model;
  const copy = cloneSkinned(src);
  const srcBones = {};
  src.traverse((o) => { if (o.isBone) srcBones[o.name] = o; });
  copy.traverse((o) => {
    if (o.isBone && srcBones[o.name]?.userData.rest) { const r = srcBones[o.name].userData.rest; o.position.copy(r.p); o.quaternion.copy(r.q); } // as made, not as posed
    if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; }
  });
  // Skin and cloth let a little light through (paint.js withSSS). Shared materials stay Compose's; a painted piece
  // already has its own subsurface. Only these copies are the Test Rig's to dispose.
  const own = [];
  copy.traverse((o) => {
    if (!o.isMesh) return;
    const mats = [].concat(o.material).map((m) => {
      const kind = !m.userData?.sss && materialKind(m, o.name);
      if (!kind) return m;
      const c = withSSS(m.clone());
      c.userData.sss.amount.value = SSS[kind].amount;
      c.userData.sss.radius.value = SSS[kind].radius;
      c.userData.sss.color.value.set(SSS[kind].color);
      own.push(c);
      return c;
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
  });
  copy.position.set(0, 0, 0);
  const wrap = new THREE.Group(); wrap.add(copy);
  const body = new THREE.Group(); body.add(wrap);
  const root = new THREE.Group(); root.add(body);
  root.updateMatrixWorld(true);
  const named = {};
  copy.traverse((o) => { if (o.isBone) named[o.name] = o; });
  const map = mapBones(Object.keys(named));
  const at = (std) => named[map[std]].getWorldPosition(new THREE.Vector3());
  const left = at('LeftUpLeg').sub(at('RightUpLeg')), up = at('Head').sub(at('Hips'));
  wrap.rotation.y = -facingYaw(left.toArray(), up.toArray());
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  wrap.scale.multiplyScalar(TUNE.height / (size.y || 1));
  root.updateMatrixWorld(true);
  box.setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  wrap.position.set(-c.x, -box.min.y, -c.z);
  root.updateMatrixWorld(true);
  return { root, body, rig: makeRig(copy, body), own };
}

// --- the overlay ---
const capsHtml = () => KEYCAPS.map((g, gi) => `<span class="tr-capgrp" title="${esc(g.tip || `${g.label}: ${g.caps.map((c) => c[0]).join(' ')}`)}">${g.caps.map((c, ci) => `<kbd data-cap="${gi}.${ci}"${c[0] === 'Mouse' ? ' class="mouse"' : ''}>${esc(c[0])}</kbd>`).join('')}<span>${esc(g.label)}</span></span>`).join('');
const sliderRow = (key, label, min, max, stepBy, value, text, tip) => `<div class="sl" title="${esc(tip)}"><label for="trl-${key}">${label}</label><input class="range" type="range" title="${esc(tip)}" id="trl-${key}" data-look="${key}" min="${min}" max="${max}" step="${stepBy}" value="${value}" style="--p:${((value - min) / (max - min)) * 100}%"><span class="v" id="trv-${key}">${text}</span></div>`;
const switchRow = (key, label, small, on, tip) => `<label class="tg" title="${esc(tip)}"><span>${label}<small>${small}</small></span><input class="sw" type="checkbox" role="switch" data-look="${key}" ${on ? 'checked' : ''}></label>`;
function lookHtml(l, quality) {
  return `<h3>Look</h3>
    <div class="tr-quality" role="radiogroup" aria-label="Picture quality" title="How good the picture looks. Fast keeps it smooth on any computer."><span>Picture</span>${Object.entries(QUALITY).map(([k, q]) => `<button class="chip" type="button" role="radio" aria-checked="${quality === k}" data-quality="${k}" title="${esc(q.tip)}">${esc(q.label)}</button>`).join('')}</div>
    <label class="row-sel" title="${PLACE_TIP}"><span>Place</span><select class="inp" data-look="env">${opts(RIG_ENVS, l.env)}</select></label>
    <div class="tr-lights" role="radiogroup" aria-label="Light">${Object.entries(RIG_LIGHTS).map(([k, p]) => `<button class="chip" type="button" role="radio" aria-checked="${l.light === k}" data-look-light="${k}" title="${esc(p.tip)}">${esc(p.label)}</button>`).join('')}</div>
    ${sliderRow('time', 'Time of day', TIME.min, TIME.max, 0.5, l.time, timeLabel(l.time), 'Where the sun is: low in the morning and evening, high at noon')}
    ${sliderRow('brightness', 'Brightness', 0.3, 2, 0.05, l.brightness, `${l.brightness.toFixed(2)}×`, 'Make the whole picture lighter or darker')}
    <div class="sl" title="The colour of the light behind your character that outlines its edges"><label for="trl-rim">Edge light</label><input class="tint" type="color" title="The colour of the light that outlines your character" id="trl-rim" data-look="rim" value="${esc(l.rim)}"><span class="v">${esc(l.rim)}</span></div>
    ${switchRow('fog', 'Fog', 'A soft haze far away', l.fog, 'Fade the far side of the place into a haze')}
    ${switchRow('rain', 'Rain', 'Rain falls around you', l.rain, 'Let it rain around your character')}
    ${switchRow('glow', 'Glow', 'Lit parts shine softly', l.glow, 'Lights, signs and glowing parts give off a soft glow')}
    <p class="fine keep">The game waits while this is open. Your scene gets the same look, and Undo takes each change back.</p>
    <button class="btn pri" type="button" data-look-close title="Close Look and play again (Esc)">Back to playing</button>`;
}

function start() {
  if (run || !available()) return;
  const el = document.createElement('div');
  el.className = 'tr-wrap';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Test rig');
  el.innerHTML = `<canvas class="tr-cv" tabindex="-1" title="Click to look around with the mouse"></canvas>
    <div class="tr-state" aria-live="polite" title="What the character is doing right now">Standing</div>
    <div class="tr-prompt" aria-live="polite" hidden></div>
    <div class="tr-photo" aria-live="polite" hidden></div>
    <div class="tr-caps" aria-label="Keys">${capsHtml()}</div>
    <div class="tr-top">
      <button class="btn sec tr-lookbtn" type="button" aria-expanded="false" aria-controls="tr-look" title="Change the place, light, time of day, fog, rain and glow. The game waits while it is open.">Look</button>
      <button class="btn sec tr-photobtn" type="button" title="Pause and make a ray-traced photo of this moment (P). Any key plays on.">Photo</button>
      <button class="btn sec icon tr-helpbtn" type="button" aria-label="How to play" title="How to play (?)">?</button>
      <button class="btn sec tr-exit" type="button" title="Go back to the Scene screen (Esc)">Back to scene</button>
    </div>
    <section class="tr-look" id="tr-look" aria-label="Look" hidden></section>
    <div class="tr-howto" role="note" aria-label="How to play" hidden><h3>How to play</h3>
      <ul>${HOWTO.map(([k, d]) => `<li><kbd>${esc(k)}</kbd><span>${esc(d)}</span></li>`).join('')}</ul>
      <button class="btn pri" type="button" data-howto-ok title="Hide this card. Press ? to see it again.">Got it</button></div>
    <div class="tr-hint" title="Click the scene to look around">Click the scene to start. Your mouse turns the camera.</div>`;
  document.body.append(el);
  const cv = el.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft edges from shadow.radius (High)
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14110f);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 });
  const hemi = new THREE.HemisphereLight(0xfff1e8, 0x2b2624, 1.1);
  const rim = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(hemi, sun, rim, rim.target);
  const arena = arenaMeshes();
  scene.add(arena);
  const ch = character(ctx.studio());
  scene.add(ch.root);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400);

  run = {
    el, cv, renderer, scene, arena, camera, ch, sun, hemi, rim, quality: qualityOf(globalThis.localStorage), size: { scale: 1 }, times: [], photo: null, post: null, pt: null, keys: new Set(), aim: false, yaw: 0, pitch: -0.25, locked: false, unlockedAt: 0,
    player: newPlayer(), anim: newAnim(), pose: poseFor(newAnim()), last: performance.now(), raf: 0, label: '', prompt: '', lit: '', mouseAt: 0,
    panelOpen: false, place: null, placeSlug: null, builds: 0, hdris: {}, skyKey: '', rain: null, ownRain: null,
  };
  const resize = () => {
    if (!run) return;
    run.w = innerWidth; run.h = innerHeight - 38;
    run.size = { scale: maxScale(run) }; // a new size: try the full picture again
    sizeRenderer(run);
  };
  run.resize = resize;
  setQuality(run, run.quality);
  resize();
  applyLook(run, ctx.scene());

  const look = el.querySelector('.tr-look'), howto = el.querySelector('.tr-howto');
  const setHowTo = (show) => { howto.hidden = !show; if (!show) rememberHowTo(globalThis.localStorage); };
  howto.hidden = !showHowTo(globalThis.localStorage);
  const setPanel = (open) => {
    stopPhoto(run);
    run.panelOpen = open;
    run.keys.clear(); run.aim = false; // the game waits: nothing stays held
    el.querySelector('.tr-lookbtn').setAttribute('aria-expanded', String(open));
    if (open) {
      if (document.pointerLockElement === cv) document.exitPointerLock();
      look.innerHTML = lookHtml(rigLookOf(ctx.scene()), run.quality);
      look.hidden = false;
      look.querySelector('select')?.focus();
    } else { look.hidden = true; cv.focus(); }
  };

  const onKey = (e) => {
    if (!run) return;
    const route = keyRoute(e.key, { panelOpen: run.panelOpen });
    if (route === 'pass') return;
    if (run.photo) { // any key plays on (and does nothing else)
      e.preventDefault(); e.stopPropagation();
      if (e.type === 'keydown' && !e.repeat) stopPhoto(run);
      return;
    }
    if (route === 'panel') return; // the panel's own controls get it; the overlay stops it reaching Compose
    e.preventDefault(); e.stopPropagation(); // Compose shortcuts, the hotkey sheet and Ctrl menu keys stay out of it
    if (route === 'close') { if (e.type === 'keydown') setPanel(false); return; }
    if (e.type === 'keydown') run.keys.add(e.code); else run.keys.delete(e.code);
    if (e.type === 'keydown' && e.key === 'Escape') {
      if (run.locked) document.exitPointerLock();
      else if (performance.now() - run.unlockedAt > 300) stopTestRig(); // the Esc that freed the mouse doesn't also leave
      return;
    }
    if (e.type === 'keydown' && e.key === '?' && !e.repeat) setHowTo(howto.hidden);
    if (e.type === 'keydown' && e.code === 'KeyR' && !e.repeat) { run.player = newPlayer(START); run.yaw = 0; }
    if (e.type === 'keydown' && e.code === 'KeyP' && !e.repeat) startPhoto(run);
  };
  const onBlur = () => { run.keys.clear(); run.aim = false; };
  const onMouse = (e) => {
    if (!run.locked) return;
    run.mouseAt = performance.now();
    run.yaw -= e.movementX * 0.0025;
    run.pitch = THREE.MathUtils.clamp(run.pitch - e.movementY * 0.0025, -1.2, 0.7);
  };
  const onDown = (e) => {
    if (run.photo) { stopPhoto(run); return; } // a click plays on too
    if (run.panelOpen) setPanel(false); // clicking the scene closes Look and plays on
    if (e.button === 2) run.aim = true;
    if (!run.locked) cv.requestPointerLock()?.catch?.(() => {});
  };
  const onUp = (e) => { if (e.button === 2) run.aim = false; };
  const onLock = () => {
    run.locked = document.pointerLockElement === cv;
    if (!run.locked) { run.unlockedAt = performance.now(); run.aim = false; }
    el.querySelector('.tr-hint').textContent = run.locked ? 'Esc frees the mouse.' : 'Mouse is free. Click the scene to play, or press Esc again to go back.';
  };
  // Look panel: dragging a slider shows it at once; letting go (change) is one scene change, so one undo step.
  const valueOf = (t) => (t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value);
  const commit = async (key, value) => {
    const patch = lookChange(ctx.scene(), key, value);
    applyLook(run, { ...ctx.scene(), ...patch });
    await ctx.change(patch);
    applyLook(run, ctx.scene());
  };
  look.addEventListener('input', (e) => {
    const key = e.target.dataset.look;
    if (!key || e.target.type === 'checkbox' || e.target.tagName === 'SELECT') return;
    const v = valueOf(e.target);
    applyLook(run, { ...ctx.scene(), ...lookChange(ctx.scene(), key, v) });
    if (e.target.type === 'range') {
      e.target.style.setProperty('--p', `${((v - e.target.min) / (e.target.max - e.target.min)) * 100}%`);
      el.querySelector(`#trv-${key}`).textContent = key === 'time' ? timeLabel(v) : `${v.toFixed(2)}×`;
    } else e.target.nextElementSibling.textContent = v;
  });
  look.addEventListener('change', (e) => { const key = e.target.dataset.look; if (key) commit(key, valueOf(e.target)); });
  look.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.lookClose !== undefined) { setPanel(false); return; }
    if (b.dataset.quality) {
      setQuality(run, b.dataset.quality);
      look.querySelectorAll('[data-quality]').forEach((q) => q.setAttribute('aria-checked', String(q === b)));
      return;
    }
    if (b.dataset.lookLight) {
      await commit('light', b.dataset.lookLight);
      if (!run?.panelOpen) return;
      look.innerHTML = lookHtml(rigLookOf(ctx.scene()), run.quality); // a preset moves every slider
      look.querySelector(`[data-look-light="${b.dataset.lookLight}"]`)?.focus();
    }
  });
  el.addEventListener('keydown', (e) => e.stopPropagation()); // keys typed into the panel never reach Compose
  el.addEventListener('keyup', (e) => e.stopPropagation());
  el.querySelector('.tr-lookbtn').addEventListener('click', () => setPanel(!run.panelOpen));
  el.querySelector('.tr-photobtn').addEventListener('click', () => { if (run.panelOpen) setPanel(false); startPhoto(run); });
  el.querySelector('.tr-helpbtn').addEventListener('click', () => setHowTo(howto.hidden));
  howto.querySelector('[data-howto-ok]').addEventListener('click', () => setHowTo(false));
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', resize);
  document.addEventListener('mousemove', onMouse);
  document.addEventListener('pointerlockchange', onLock);
  cv.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  el.querySelector('.tr-exit').addEventListener('click', () => stopTestRig());
  run.off = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', resize);
    document.removeEventListener('mousemove', onMouse);
    document.removeEventListener('pointerlockchange', onLock);
    window.removeEventListener('mouseup', onUp);
  };
  run.raf = requestAnimationFrame(frame);
}

// --- the look, read from the scene (rig-look.js): the place, the light rig, fog, rain and glow ---
function disposeTree(o) {
  o.traverse((x) => { x.geometry?.dispose(); [].concat(x.material || []).forEach((m) => m.dispose()); });
}
// A sky picture as an equirect texture: the renderer makes its own reflection maps from it, and the path tracer
// reads it as it is.
function hdriOf(r, name) {
  r.hdris[name] ||= new HDRLoader().loadAsync(`/img/hdri/${name}.hdr`).then((tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  });
  return r.hdris[name];
}
// The light and reflections come from a sky picture (rig-quality.js lightingHdri): the scene's own, else the place's.
function setSky(r) {
  const e = ENVIRONMENTS[r.placeSlug];
  const L = lightingHdri(r.look, e);
  const turn = L.rotation ?? (e?.sky.hdri ? skyRotation(e) : 0);
  const key = `${L.name}|${turn}|${L.intensity}|${e?.light.env}`;
  if (key === r.skyKey) return;
  r.skyKey = key;
  r.scene.environmentIntensity = 0.5 * (e?.light.env ?? 1) * L.intensity;
  r.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(turn), 0);
  hdriOf(r, L.name).then((tex) => { if (run === r && r.skyKey === key) r.scene.environment = tex; }, () => { /* no reflections, the lights still work */ });
}
// The place goes round the play area. A room or a white studio is made big enough to hold all of it; an outdoor
// place is spread out so its buildings stand outside the walls. ponytail: one rule for every outdoor place; give
// each its own fit if a new one puts something tall right next to the play area.
const ARENA_SPAN = 33, OUTDOOR = 1.7;
async function setPlace(r, slug) {
  if (r.placeSlug === slug) return;
  r.placeSlug = slug;
  setSky(r);
  const build = ++r.builds;
  const e = ENVIRONMENTS[slug];
  const gltf = new GLTFLoader();
  let group;
  try { group = await buildEnvironment(e, { loadGlb: async (f) => (await gltf.loadAsync(`/env/${encodeURIComponent(f)}`)).scene }); } catch { return; } // the plain play area stays
  if (run !== r || build !== r.builds) { disposeTree(group); return; }
  const shell = envParts(e).find((p) => p.room || p.cyc);
  if (shell) {
    const b = partBounds(shell), s = Math.max(1, ARENA_SPAN / Math.min(b.max[0] - b.min[0], b.max[2] - b.min[2]));
    group.scale.setScalar(s);
    group.position.set((-(b.min[0] + b.max[0]) / 2) * s, 0, (-(b.min[2] + b.max[2]) / 2) * s);
  } else group.scale.setScalar(OUTDOOR);
  group.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  if (r.place) { r.scene.remove(r.place); disposeTree(r.place); }
  r.place = group;
  r.scene.add(group);
  r.arena.traverse((o) => { if (o.userData.plain) o.visible = false; });
  r.ownRain = group.getObjectByName('rain') || null;
  const sky = e.sky;
  r.scene.backgroundRotation.set(0, 0, 0);
  r.scene.backgroundIntensity = 1;
  r.scene.background = new THREE.Color(sky.color || e.light.sky[0]);
  r.hemi.color.set(e.light.sky[0]);
  r.hemi.groundColor.set(e.light.sky[1]);
  r.hemiBase = 0.6 + e.light.sky[2];
  applyLights(r);
  if (!sky.hdri) return;
  try {
    const tex = await hdriOf(r, sky.hdri);
    if (run !== r || build !== r.builds) return;
    r.scene.background = tex;
    r.scene.backgroundIntensity = sky.intensity ?? 1;
    r.scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(skyRotation(e)), 0);
  } catch { /* the plain sky colour stays */ }
}
function applyLights(r) {
  const { lights, exposure, fog } = r.look;
  const studio = lightsFromPreset('studio');
  const lit = lights.preset === 'match' ? { ...studio, key: { ...studio.key, ...sunAt(13) } } : lights; // the scene's own light: shown as Studio at 1 pm
  const dir = (c, d) => {
    const az = THREE.MathUtils.degToRad(c.azimuth), el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(c.elevation, 3, 89));
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(d);
  };
  r.sun.position.copy(dir(lit.key, 30));
  r.sun.color.set(lit.key.color);
  r.sun.intensity = lit.key.on ? lit.key.intensity * 2 : 0;
  r.hemi.intensity = (r.hemiBase ?? 1.1) * (0.4 + (lit.fill.on ? lit.fill.intensity : 0));
  r.rim.color.set(lit.rim.color);
  r.rim.intensity = lit.rim.on ? lit.rim.intensity * 1.6 : 0;
  r.renderer.toneMapping = TONE[r.look.tone] ?? THREE.NeutralToneMapping;
  r.renderer.toneMappingExposure = exposure;
  r.scene.fog = fog.on ? new THREE.FogExp2(fog.color, fog.density) : null;
  configurePost(r);
  const rain = r.look.rain && !r.ownRain; // Night City has its own rain
  if (rain && !r.rain) r.scene.add(r.rain = buildRain(ENVIRONMENTS['night-city-rain'].rain));
  else if (!rain && r.rain) { r.scene.remove(r.rain); disposeTree(r.rain); r.rain = null; }
}
/** Show a scene's look in the Test Rig (the scene itself, or a preview of a change while a slider moves). */
function applyLook(r, scene) {
  if (!r || run !== r) return;
  r.look = mergeLook(scene.look);
  applyLights(r);
  setSky(r);
  setPlace(r, rigLookOf(scene).env);
}

// --- picture quality (rig-quality.js): Fast or High, and a picture size that follows the frame rate ---
const maxScale = (r) => Math.min(devicePixelRatio || 1, QUALITY[r.quality].pixelRatio);
function sizeRenderer(r) {
  r.renderer.setPixelRatio(r.size.scale);
  r.renderer.setSize(r.w, r.h, false);
  r.camera.aspect = r.w / r.h;
  r.camera.updateProjectionMatrix();
  configurePost(r);
}
// The main scene's effects (post.js): corner shading on High, glow when the look has it, edge smoothing.
function configurePost(r) {
  if (!r.look || !r.w) return;
  const fx = rigEffects(r.look, r.quality);
  if (fx.composer) {
    r.post ||= new Post(r.renderer, r.scene, r.camera);
    r.post.configure(r.look, fx, r.w, r.h, r.size.scale);
  } else if (r.post) { r.post.dispose(); r.post = null; }
}
function setQuality(r, quality) {
  r.quality = Object.hasOwn(QUALITY, quality) ? quality : 'high';
  saveQuality(globalThis.localStorage, r.quality);
  const q = QUALITY[r.quality];
  r.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  r.sun.shadow.radius = q.shadowRadius;
  r.sun.shadow.map?.dispose();
  r.sun.shadow.map = null; // made again at the new size on the next frame
  r.times = [];
  r.size = { scale: maxScale(r) };
  if (r.w) sizeRenderer(r);
  r.el.dataset.quality = r.quality;
}
// Once a second: the frame rate, and on a slow computer a smaller picture so play stays smooth.
function trackFps(r, now) {
  r.times.push(now);
  if (now - r.times[0] < 1000) return;
  const fps = fpsOf(r.times);
  r.times = [now];
  r.el.dataset.fps = fps.toFixed(1);
  const next = adaptScale(r.size, fps, maxScale(r));
  if (next.scale !== r.size.scale) { r.size = next; sizeRenderer(r); } else r.size = next;
  r.el.dataset.scale = String(r.size.scale);
}

// --- Photo: pause and let the path tracer (post.js PathTraced) build up a ray-traced picture of this frame ---
function startPhoto(r) {
  if (!r || r.photo) return;
  if (document.pointerLockElement === r.cv) document.exitPointerLock();
  r.keys.clear(); r.aim = false;
  const photo = r.photo = { ready: false, text: '' };
  r.el.querySelector('.tr-photo').hidden = false;
  r.el.querySelector('.tr-prompt').hidden = true;
  r.el.querySelector('.tr-photobtn').setAttribute('aria-pressed', 'true');
  r.pt ||= new PathTraced(r.renderer);
  r.pt.setScene(r.scene, r.camera).then(() => { if (r.photo === photo) photo.ready = true; }, (err) => {
    if (r.photo !== photo) return;
    stopPhoto(r);
    toast(`Photo could not start on this computer: ${err.message}`);
  });
}
function stopPhoto(r) {
  if (!r?.photo) return;
  r.photo = null;
  r.el.querySelector('.tr-photo').hidden = true;
  r.el.querySelector('.tr-photobtn').removeAttribute('aria-pressed');
  r.prompt = null; // shown again on the next frame
  r.times = [];
  r.last = performance.now();
}
function photoFrame(r) {
  const ph = r.photo;
  if (ph.ready) r.pt.renderSample();
  else if (r.post?.composer) r.post.render(); else r.renderer.render(r.scene, r.camera);
  const text = photoLabel(r.pt.samples, r.pt.maxSamples, ph.ready);
  if (text !== ph.text) { ph.text = text; r.el.querySelector('.tr-photo').textContent = text; }
}

const ray = new THREE.Raycaster();
function frame(now) {
  if (!run) return;
  const r = run;
  if (r.photo) { photoFrame(r); r.raf = requestAnimationFrame(frame); return; } // the game waits
  trackFps(r, now);
  const dt = Math.min(0.1, (now - r.last) / 1000);
  r.last = now;
  const k = (c) => r.keys.has(c);
  const input = r.panelOpen ? { yaw: r.yaw, pitch: r.pitch } : { // Look open: the game waits, nothing is pressed
    x: (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0), z: (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0), yaw: r.yaw, pitch: r.pitch,
    jump: k('Space'), crouch: k('ControlLeft') || k('ControlRight') || k('KeyC'), sprint: k('ShiftLeft') || k('ShiftRight'), aim: r.aim, dodge: k('KeyQ'),
  };
  const n = Math.max(1, Math.ceil(dt * 120));
  for (let i = 0; i < n; i++) {
    r.player = step(r.player, input, dt / n);
    r.anim = stepAnim(r.anim, r.player, dt / n);
  }
  // Pose: ease from what's showing towards this state's pose.
  const target = poseFor(r.anim, r.player);
  r.pose = mixPose(wrapSpin(r.pose, target), target, 1 - Math.exp(-dt * (r.anim.state === 'roll' || r.player.jumpKind === 'double' ? 30 : 14)));
  const p = r.player;
  r.ch.root.position.set(...p.pos);
  r.ch.root.rotation.y = p.yaw;
  applyPose(r.ch.rig, r.pose);
  const label = stateLabel(r.anim.state, p);
  if (label !== r.label) { r.label = label; r.el.querySelector('.tr-state').textContent = label; }
  // Keycaps light up while held; the hint says what you can do right here.
  const held = new Set(r.keys);
  if (now - r.mouseAt < 150) held.add('Mouse');
  const lit = KEYCAPS.flatMap((g, gi) => g.caps.filter((c) => capLit(c, held)).map((c) => `${gi}.${g.caps.indexOf(c)}`));
  if (lit.join() !== r.lit) { r.lit = lit.join(); r.el.querySelectorAll('.tr-caps kbd').forEach((kb) => kb.classList.toggle('on', lit.includes(kb.dataset.cap))); }
  const prompt = r.panelOpen ? '' : contextPrompt(p);
  if (prompt !== r.prompt) { r.prompt = prompt; const pe = r.el.querySelector('.tr-prompt'); pe.textContent = prompt; pe.hidden = !prompt; }

  // Camera: orbit behind the character, pulled in when a block is in the way.
  const low = ['crouch', 'slide', 'roll'].includes(r.anim.state);
  const focus = new THREE.Vector3(p.pos[0], p.pos[1] + (low ? 1.0 : 1.5), p.pos[2]);
  const look = new THREE.Vector3(Math.sin(r.yaw) * Math.cos(r.pitch), Math.sin(r.pitch), Math.cos(r.yaw) * Math.cos(r.pitch));
  let dist = 4.5;
  ray.set(focus, look.clone().negate());
  ray.far = dist;
  const hit = ray.intersectObjects(r.arena.children, false).find((h) => h.object.isMesh);
  if (hit) dist = Math.max(0.6, hit.distance - 0.2);
  r.camera.position.copy(focus).addScaledVector(look, -dist);
  r.camera.position.y = Math.max(0.2, r.camera.position.y);
  r.camera.lookAt(focus);
  // The edge light sits beyond the character, facing the camera; rain falls round the character.
  r.rim.position.copy(focus).addScaledVector(look, 6).add(new THREE.Vector3(0, 3, 0));
  r.rim.target.position.copy(focus);
  const t = now / 1000;
  if (r.rain) { r.rain.position.set(p.pos[0], 0, p.pos[2]); r.rain.userData.update(t); }
  r.ownRain?.userData.update(t);
  if (r.post?.composer) r.post.render(); else r.renderer.render(r.scene, r.camera);
  r.raf = requestAnimationFrame(frame);
}

/** Leave the test rig (Esc, Back to scene, or Compose closing). The look already went to the scene as it was picked. */
export function stopTestRig() {
  if (!run) return;
  const r = run;
  run = null;
  cancelAnimationFrame(r.raf);
  r.off?.();
  if (document.pointerLockElement === r.cv) document.exitPointerLock();
  r.ch.root.removeFromParent(); // the character shares Compose's meshes: not disposed, only its own skin copies
  r.ch.own.forEach((m) => m.dispose());
  disposeTree(r.scene);
  for (const h of Object.values(r.hdris)) h.then((tex) => tex.dispose(), () => {});
  r.post?.dispose();
  r.pt?.dispose();
  r.renderer.dispose();
  r.renderer.forceContextLoss();
  r.el.remove();
  ctx?.draw?.();
}
