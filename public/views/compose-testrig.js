// Compose, Test rig (humanoids with a skeleton only): play the character in a small arena of blocks to see the rig
// move. It runs on its own canvas over Compose with a copy of the model, so the Compose scene is never touched:
// leaving just removes the overlay. Movement and poses live in lib/testrig.js, the bone work in lib/testrig-rig.js.
import * as THREE from 'three';
import { keyOf } from '../lib/shortcuts.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { esc, toast } from '../app.js';
import { mapBones } from '../lib/motion.js';
import { modelInfo } from '../lib/rig.js';
import { canPoseByHand } from '../lib/handpose.js';
import { ARENA, START, TUNE, newPlayer, step, newAnim, stepAnim, poseFor, mixPose, wrapSpin, stateLabel, facingYaw, topAt } from '../lib/testrig.js';
import { makeRig, applyPose } from '../lib/testrig-rig.js';

let ctx; // same ctx as compose-motion
let run = null; // the live session, or null

export function initTestRig(c) { ctx = c; stopTestRig(); }

function available() {
  const s = ctx?.studio();
  if (!s?.model || modelInfo(s, ctx.scene().motion?.type || 'auto').type !== 'humanoid') return false;
  const names = [];
  s.model.traverse((o) => { if (o.isBone) names.push(o.name); });
  return canPoseByHand(mapBones(names));
}

export function renderTestRigGroup() {
  if (!available()) return '';
  return `<div class="grp" id="grp-testrig"><h3>Test rig</h3><p class="fine">Run, jump and climb with this character in a small play area, to see how the rig moves.</p>
    <button class="btn pri" type="button" data-tr="start" title="Play this character in a small arena (${keyOf('testrig')}). Press Esc to come back here">Test rig</button></div>`;
}
export async function onTestRigClick(t) {
  if (t.dataset.tr !== 'start') return false;
  try { start(); } catch (err) { stopTestRig(); toast(`Test rig could not start: ${err.message}`); }
  return true;
}

const KEYS = [
  ['W A S D', 'Move'], ['Mouse', 'Look around'], ['Shift', 'Sprint'], ['Space', 'Jump, press again in the air to jump again'],
  ['Ctrl or C', 'Crouch, or slide when running fast'], ['Ctrl + Space', 'Bullet jump: launch where you look'],
  ['Hold right mouse', 'Glide while falling'], ['Q', 'Roll'], ['Run beside a wall', 'Wall run'], ['Jump at a ledge', 'Climb up'],
  ['R', 'Back to the start'], ['Esc', 'Free the mouse, press again to leave'],
];

function arenaMeshes() {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), new THREE.MeshStandardMaterial({ color: 0x2b2624, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const grid = new THREE.GridHelper(30, 30, 0x4a3d39, 0x3a302d);
  grid.position.y = 0.005;
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
    if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; }
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
  return { root, body, rig: makeRig(copy, body) };
}

function start() {
  if (run || !available()) return;
  const el = document.createElement('div');
  el.className = 'tr-wrap';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Test rig');
  el.innerHTML = `<canvas class="tr-cv" title="Click to look around with the mouse"></canvas>
    <div class="tr-state" aria-live="polite" title="What the character is doing right now">Standing</div>
    <ul class="tr-keys" aria-label="Keys">${KEYS.map(([k, d]) => `<li><kbd>${esc(k)}</kbd><span>${esc(d)}</span></li>`).join('')}</ul>
    <button class="btn sec tr-exit" type="button" title="Go back to Compose (Esc)">Back to Compose</button>
    <div class="tr-hint" title="Click the scene to look around">Click the scene to start. Your mouse turns the camera.</div>`;
  document.body.append(el);
  const cv = el.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14110f);
  scene.fog = new THREE.Fog(0x14110f, 25, 60);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(8, 16, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 50 });
  scene.add(new THREE.HemisphereLight(0xfff1e8, 0x2b2624, 1.1), sun);
  const arena = arenaMeshes();
  scene.add(arena);
  const ch = character(ctx.studio());
  scene.add(ch.root);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 120);

  run = {
    el, cv, renderer, scene, arena, camera, ch, keys: new Set(), aim: false, yaw: 0, pitch: -0.25, locked: false, unlockedAt: 0,
    player: newPlayer(), anim: newAnim(), pose: poseFor(newAnim()), last: performance.now(), raf: 0, label: '',
  };
  const resize = () => { const w = innerWidth, h = innerHeight - 38; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  resize();
  const isGameKey = (e) => !/^F\d+$/.test(e.key);
  const onKey = (e) => {
    if (!run || !isGameKey(e)) return;
    e.preventDefault(); e.stopPropagation(); // Compose shortcuts, the hotkey sheet and Ctrl menu keys stay out of it
    if (e.type === 'keydown' && e.key === 'Escape') {
      if (run.locked) document.exitPointerLock();
      else if (performance.now() - run.unlockedAt > 300) stopTestRig(); // the Esc that freed the mouse doesn't also leave
      return;
    }
    if (e.type === 'keydown' && e.code === 'KeyR' && !e.repeat) { run.player = newPlayer(START); run.yaw = 0; }
    if (e.type === 'keydown') run.keys.add(e.code); else run.keys.delete(e.code);
  };
  const onBlur = () => { run.keys.clear(); run.aim = false; };
  const onMouse = (e) => {
    if (!run.locked) return;
    run.yaw -= e.movementX * 0.0025;
    run.pitch = THREE.MathUtils.clamp(run.pitch - e.movementY * 0.0025, -1.2, 0.7);
  };
  const onDown = (e) => {
    if (e.button === 2) run.aim = true;
    if (!run.locked) cv.requestPointerLock()?.catch?.(() => {});
  };
  const onUp = (e) => { if (e.button === 2) run.aim = false; };
  const onLock = () => {
    run.locked = document.pointerLockElement === cv;
    if (!run.locked) { run.unlockedAt = performance.now(); run.aim = false; }
    el.querySelector('.tr-hint').textContent = run.locked ? 'Esc frees the mouse.' : 'Mouse is free. Click the scene to play, or press Esc again to go back to Compose.';
  };
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

const ray = new THREE.Raycaster();
function frame(now) {
  if (!run) return;
  const r = run;
  const dt = Math.min(0.1, (now - r.last) / 1000);
  r.last = now;
  const k = (c) => r.keys.has(c);
  const input = {
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
  r.renderer.render(r.scene, r.camera);
  r.raf = requestAnimationFrame(frame);
}

/** Leave the test rig (Esc, Back to Compose, or Compose closing). Compose was never changed, so nothing to restore. */
export function stopTestRig() {
  if (!run) return;
  const r = run;
  run = null;
  cancelAnimationFrame(r.raf);
  r.off?.();
  if (document.pointerLockElement === r.cv) document.exitPointerLock();
  r.arena.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); // the character shares Compose's meshes: not disposed
  r.ch.root.removeFromParent();
  r.renderer.dispose();
  r.renderer.forceContextLoss();
  r.el.remove();
  ctx?.draw?.();
}
