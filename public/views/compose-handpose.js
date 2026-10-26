// Compose, Pose by hand (humanoids with a skeleton only): grab dots on the hands, feet and hips, rotate rings on
// the head, neck and back, mirror, feet on the floor, start over, save as a pose, and simple keyframes. Every drag
// ends in one scene change (scene.motion.pose), so Ctrl+Z undoes one drag and renders get the same pose.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { $, esc, send, toast } from '../app.js';
import { mapBones } from '../lib/motion.js';
import { modelInfo } from '../lib/rig.js';
import { CHAINS, RINGS, LABELS, LOOP, canPoseByHand, solveTwoBone, readPose, readBone, writeBone, mirrorName, mirrorEuler, applyHips, toSpace, addKey, toPreset } from '../lib/handpose.js';
import { reloadPresets } from './compose-motion.js';

let ctx; // same ctx as compose-motion
let on = false, mirror = false, lockFeet = true, keyT = 0;
let rigCache = null, handles = null, tc = null, drag = null, swallowClick = false, cv = null;
let playing = false, raf = 0, t0 = 0;

export function initHandPose(c) { ctx = c; stopHandPose(); }
const motionOf = () => ctx.scene().motion || {};
const setMotion = (patch) => ctx.change({ motion: { ...motionOf(), ...patch } });

function rigOf(studio) {
  const m = studio?.model;
  if (!m) return null;
  if (rigCache?.model === m) return rigCache;
  const byName = {};
  m.traverse((o) => { if (o.isBone) byName[o.name] = o; });
  const map = mapBones(Object.keys(byName));
  return (rigCache = { model: m, byStd: Object.fromEntries(Object.entries(map).map(([std, n]) => [std, byName[n]])), ok: canPoseByHand(map) });
}
// Only for a humanoid with arms and legs in its skeleton: cars and unrigged models never see it.
function available() {
  const s = ctx?.studio();
  return Boolean(s?.model && modelInfo(s, motionOf().type || 'auto').type === 'humanoid' && rigOf(s)?.ok);
}
export const isPosing = () => on;

const tip = (s) => `title="${esc(s)}"`;
const sw = (key, label, small, checked, title) => `<label class="tg" ${tip(title)}><span>${label}<small>${small}</small></span><input class="sw" type="checkbox" role="switch" data-hp-opt="${key}" ${checked ? 'checked' : ''}></label>`;

export function renderHandPoseGroup() {
  if (!available()) { if (on) stopHandPose(); return ''; }
  const keys = motionOf().keys || [];
  const body = on ? `<p class="fine">Drag an orange dot: a hand or foot bends its arm or leg, the dot at the hips moves the whole body. Click a blue dot (head, neck, back), then drag its rings to turn it.</p>
      ${sw('mirror', 'Mirror left and right', 'Move one side, the other copies it', mirror, 'When on, moving a left hand or foot moves the right one the same way (and the other way round)')}
      ${sw('feet', 'Keep feet on the floor', 'Feet stay put when the body moves', lockFeet, 'When on, moving the body keeps both feet planted, and a foot can not go below the floor')}
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-act="undo" ${tip('Undo the last drag (Ctrl+Z)')}>Undo</button>
        <button class="btn sm ghostbtn" type="button" data-hp="reset" ${tip('Put every joint back the way the model was made')}>Start over</button></div>
      <h4 class="fine">Save this pose</h4>
      <div class="mg-row"><input class="inp" type="text" id="hp-name" maxlength="60" placeholder="My pose" aria-label="Pose name" ${tip('A name for this pose. It shows up under Pick a pose')}>
        <button class="btn sm sec" type="button" data-hp="save" ${tip('Save this pose so you can use it again on any character')}>Save pose</button></div>
      <h4 class="fine">Make it move</h4>
      <div class="sl" ${tip('Pick a moment in the loop, then Add key to remember the pose at that moment')}><label for="hp-time">Moment</label><input id="hp-time" type="range" min="0" max="${LOOP}" step="0.1" value="${keyT}" data-hp-time><span class="v" id="v-hp-time">${keyT.toFixed(1)} s</span></div>
      <div class="mg-row"><button class="btn sm sec" type="button" data-hp="key" ${tip('Remember the pose at this moment')}>Add key</button>
        <button class="btn sm sec" type="button" data-hp="play" ${keys.length < 2 ? 'disabled' : ''} ${tip(keys.length < 2 ? 'Add at least two keys to play' : 'Play the keys as a loop')}>${playing ? 'Stop' : 'Play loop'}</button></div>
      ${keys.length ? `<div class="chips" role="group" aria-label="Keys">${keys.map((k, i) => `<span class="chipset"><button class="chip" type="button" data-hp-go="${i}" ${tip('Show and edit this key')}>${k.t.toFixed(1)} s</button><button class="chip sm" type="button" data-hp-del="${i}" ${tip('Remove this key')} aria-label="Remove key at ${k.t.toFixed(1)} s">✕</button></span>`).join('')}</div>`
        : '<p class="fine">Pose, pick a moment, Add key. Two or more keys play as a loop.</p>'}
      <button class="btn sm pri" type="button" data-hp="toggle" aria-pressed="true" ${tip('Hide the dots and go back to turning the model')}>Done</button>`
    : '<p class="fine">Move the arms, legs, head and body yourself, right on the model.</p>';
  return `<div class="grp" id="grp-handpose"><h3>Pose by hand</h3>${on ? '' : `<button class="btn pri" type="button" data-hp="toggle" aria-pressed="false" ${tip('Show grab dots on the joints so you can drag them')}>Pose by hand</button>`}${body}</div>`;
}

// --- the 3D side ---
const V = () => new THREE.Vector3();
const front = (s) => new THREE.Vector3(0, 0, 1).transformDirection(s.pivot.matrixWorld); // the way the model faces
const chainOf = (r, end) => CHAINS[end].map((n) => r.byStd[n]);

function start() {
  const s = ctx.studio();
  const r = rigOf(s);
  on = true;
  const height = new THREE.Box3().setFromObject(s.model).getSize(V()).y || 1.8;
  handles = new THREE.Group();
  const dot = (std, color) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(height * 0.022, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    mesh.renderOrder = 999;
    mesh.userData.std = std;
    mesh.name = LABELS[std];
    handles.add(mesh);
  };
  for (const k of [...Object.keys(CHAINS), 'Hips']) dot(k, 0xff8a3d);
  for (const k of RINGS) if (r.byStd[k]) dot(k, 0x3da5ff);
  s.scene.add(handles);
  cv = s.renderer.domElement;
  tc = new TransformControls(s.camera, cv);
  tc.setMode('rotate');
  tc.setSpace('local');
  tc.setSize(0.7);
  tc.addEventListener('objectChange', () => ctx.draw());
  tc.addEventListener('dragging-changed', (e) => { if (e.value) { if (s.controls) s.controls.enabled = false; } else { freeOrbit(); commit(); } });
  s.scene.add(tc.getHelper());
  cv.addEventListener('pointerdown', onDown, true); // before the turn-the-car drag and the orbit camera
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('click', onClick, true);
  ctx.renderInspector();
  ctx.draw();
}

export function stopHandPose() {
  stopPlay();
  if (cv) {
    cv.removeEventListener('pointerdown', onDown, true);
    cv.removeEventListener('pointermove', onMove);
    cv.removeEventListener('pointerup', onUp);
    cv.removeEventListener('click', onClick, true);
  }
  if (tc) { tc.detach(); tc.getHelper().removeFromParent(); tc.dispose(); }
  handles?.removeFromParent();
  handles?.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  on = false; handles = null; tc = null; drag = null; cv = null; rigCache = null;
}

/** compose.js draw(): keep the dots on their joints whatever moved the model. */
export function syncHandPose() {
  if (!on) return;
  const s = ctx.studio();
  if (!s?.model || s.model !== rigCache?.model) { stopHandPose(); return; }
  for (const h of handles.children) rigCache.byStd[h.userData.std].getWorldPosition(h.position);
  handles.updateMatrixWorld(true);
}

const freeOrbit = () => { const s = ctx.studio(); if (s?.controls) s.controls.enabled = ctx.scene().view === 'free'; };
function ray(e) {
  const s = ctx.studio();
  const b = cv.getBoundingClientRect();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), s.camera);
  return rc;
}

function onDown(e) {
  const s = ctx.studio();
  if (!on || e.button !== 0 || !s?.model) return;
  if (tc.axis) { if (s.controls) s.controls.enabled = false; return; } // on a ring: TransformControls takes the drag
  syncHandPose();
  const hit = ray(e).intersectObjects(handles.children)[0]?.object;
  if (!hit) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  swallowClick = true;
  const r = rigCache;
  const std = hit.userData.std;
  if (RINGS.includes(std)) { tc.attach(r.byStd[std]); ctx.draw(); return; }
  tc.detach();
  if (s.controls) s.controls.enabled = false;
  const feet = Object.fromEntries(['LeftFoot', 'RightFoot'].map((f) => [f, { p: r.byStd[f].getWorldPosition(V()), q: r.byStd[f].getWorldQuaternion(new THREE.Quaternion()) }]));
  drag = {
    std, start: hit.position.clone(), hips0: motionOf().pose?.hips || [0, 0, 0], hips: motionOf().pose?.hips || null, feet,
    floor: Math.min(feet.LeftFoot.p.y, feet.RightFoot.p.y), // ponytail: floor = the lower foot when the drag starts
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(s.camera.getWorldDirection(V()), hit.position),
  };
  cv.setPointerCapture(e.pointerId);
}

function onMove(e) {
  if (!drag) return;
  const s = ctx.studio();
  const r = rigCache;
  const p = ray(e).ray.intersectPlane(drag.plane, V());
  if (!p) return;
  const fwd = front(s);
  if (drag.std === 'Hips') {
    const d = toSpace(s.pivot, p.clone().sub(drag.start));
    drag.hips = drag.hips0.map((v, i) => Math.round((v + d.getComponent(i)) * 1000) / 1000);
    applyHips(s.pivot, r.byStd.Hips, drag.hips);
    if (lockFeet) for (const f of ['LeftFoot', 'RightFoot']) solveTwoBone(chainOf(r, f), drag.feet[f].p, { pole: fwd, keepEnd: drag.feet[f].q });
  } else {
    if (lockFeet && drag.std.endsWith('Foot')) p.y = Math.max(p.y, drag.floor);
    solveTwoBone(chainOf(r, drag.std), p, { pole: drag.std.endsWith('Hand') ? fwd.negate() : fwd }); // elbows bend back, knees forward
    if (mirror) for (const n of CHAINS[drag.std]) writeBone(r.byStd[mirrorName(n)], mirrorEuler(readBone(r.byStd[n])));
  }
  ctx.draw();
}

function onUp() {
  if (!drag) return;
  const hips = drag.hips;
  drag = null;
  freeOrbit();
  commit(hips);
}
function onClick(e) { if (swallowClick) { swallowClick = false; e.stopImmediatePropagation(); } }

// The skeleton as it stands → scene.motion.pose (one undo step).
function current(hips = motionOf().pose?.hips || null) {
  return { bones: readPose(rigCache.byStd), hips: hips?.some(Boolean) ? hips : null };
}
function commit(hips) {
  if (!rigCache) return;
  const { bones, hips: h } = current(hips);
  setMotion({ presetId: null, pose: { preset: 'tpose', bones, hips: h } });
}

// --- keyframe playback (rig.js plays motion.keys whenever a clip time is set) ---
function stopPlay() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(raf);
  ctx.studio()?.setClipTime(null);
  ctx.draw();
}
function tick(now) {
  if (!playing) return;
  ctx.studio()?.setClipTime(((now - t0) / 1000) % LOOP);
  ctx.draw();
  raf = requestAnimationFrame(tick);
}

export async function onHandPoseClick(t) {
  const act = t.dataset.hp;
  if (act === 'toggle') { if (on) { stopHandPose(); ctx.renderInspector(); ctx.draw(); } else start(); return true; }
  if (!on || !rigCache) return Boolean(act || t.dataset.hpGo || t.dataset.hpDel);
  if (act === 'reset') { stopPlay(); tc.detach(); await setMotion({ presetId: null, pose: { preset: 'tpose', bones: {}, hips: null } }); return true; }
  if (act === 'save') {
    const name = $('#hp-name', ctx.root)?.value.trim() || 'My pose';
    try {
      const { pose } = await send('/api/poses', 'POST', { pose: toPreset(name, current()) });
      toast(`Saved "${pose.name}". Find it under Pick a pose.`, 'info');
      reloadPresets();
    } catch (err) { toast(err.message); }
    return true;
  }
  if (act === 'key') { stopPlay(); await setMotion({ keys: addKey(motionOf().keys, keyT, current()) }); toast(`Key added at ${keyT.toFixed(1)} s`, 'info'); return true; }
  if (act === 'play') {
    if (playing) stopPlay(); else { playing = true; tc.detach(); t0 = performance.now(); raf = requestAnimationFrame(tick); }
    ctx.renderInspector();
    return true;
  }
  const keys = motionOf().keys || [];
  if (t.dataset.hpGo) {
    const k = keys[Number(t.dataset.hpGo)];
    if (!k) return true;
    stopPlay();
    keyT = k.t;
    await setMotion({ presetId: null, pose: { preset: 'tpose', bones: k.bones, hips: k.hips || null } });
    return true;
  }
  if (t.dataset.hpDel) { stopPlay(); await setMotion({ keys: keys.filter((_, i) => i !== Number(t.dataset.hpDel)) }); return true; }
  return false;
}
export function onHandPoseInput(t) {
  if (t.dataset.hpTime === undefined) return false;
  keyT = Number(t.value);
  const v = $('#v-hp-time', ctx.root);
  if (v) v.textContent = `${keyT.toFixed(1)} s`;
  return true;
}
export function onHandPoseChange(t) {
  if (t.dataset.hpOpt === 'mirror') { mirror = t.checked; return true; }
  if (t.dataset.hpOpt === 'feet') { lockFeet = t.checked; return true; }
  return false;
}
