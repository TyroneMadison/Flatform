// Render ideas in the in-app renderer (render/blender_turntable.py --effect does the same in Blender): exploded parts,
// clay or blueprint on a Studio made only for the render, and the after-render extras on finished PNGs (poster title,
// 9:16 crop, painted or cartoon look). The maths lives in render-types.js so node tests can check it.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { explodeOffsets, verticalCrop, posterLayout } from './render-types.js';
import { applyStyle } from './style.js';

export const BLUEPRINT = '#1e3a8a'; // the Blender script uses the same blue

/** Exploded parts and clay or blueprint, on a render Studio after it loaded the model. Returns how many parts moved. */
export function applyEffect(studio, effect = {}) {
  const model = studio.model;
  if (!model || !effect) return 0;
  let moved = 0;
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  if (effect.override === 'clay') {
    const clay = new THREE.MeshStandardMaterial({ color: '#d8d2c8', roughness: 0.8, metalness: 0 });
    for (const o of meshes) o.material = Array.isArray(o.material) ? o.material.map(() => clay) : clay;
  }
  if (effect.override === 'blueprint') {
    const fill = new THREE.MeshBasicMaterial({ color: '#2a4fa8', toneMapped: false });
    // Fat lines: plain GL lines are 1 px, which vanish once the supersampled frame is scaled down.
    const line = new LineMaterial({ color: 0xffffff, linewidth: 4, toneMapped: false });
    studio.renderer.getDrawingBufferSize(line.resolution);
    for (const o of meshes) {
      o.material = Array.isArray(o.material) ? o.material.map(() => fill) : fill;
      o.add(new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(o.geometry, 25)), line));
    }
    studio.stage.visible = false; // no room, no floor: plain blueprint blue
    if (studio.dome) studio.dome.visible = false;
    studio.shadow.group.visible = false;
    studio.scene.background = new THREE.Color(BLUEPRINT);
  }
  if (effect.explode > 0 && meshes.length > 1) {
    // Measured with the turntable at rest, so the parts move along the model's own axes and turn with it.
    const turn = studio.pivot.rotation.y;
    studio.pivot.rotation.y = 0;
    studio.pivot.updateMatrixWorld(true);
    const centers = meshes.map((o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()));
    const size = studio.carSize ? Math.max(studio.carSize.x, studio.carSize.y, studio.carSize.z) : 1;
    explodeOffsets(centers.map((c) => c.toArray()), size, effect.explode).forEach((off, i) => {
      if (!off.some(Boolean)) return;
      const o = meshes[i];
      const a = o.parent.worldToLocal(centers[i].clone());
      const b = o.parent.worldToLocal(centers[i].clone().add(new THREE.Vector3(...off)));
      o.position.add(b.sub(a));
      moved++;
    });
    studio.pivot.rotation.y = turn;
    studio.pivot.updateMatrixWorld(true);
  }
  return moved;
}

const loadImage = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

/** Painted or cartoon look on a finished picture (style.js). Returns a canvas. A big picture is filtered at half size. */
export async function styled(src, style) {
  const img = await loadImage(src);
  const scale = img.width > 1600 ? 0.5 : 1; // ponytail: half size keeps the brush filter near 10 s; full size when it matters
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = canvasOf(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const out = applyStyle(g.getImageData(0, 0, w, h), style, style === 'painterly' ? { radius: 4 } : undefined);
  g.putImageData(new ImageData(out.data, w, h), 0, 0);
  return c;
}

/** Hero poster: the picture with big title text near the top and a soft shade behind it so it reads on any background. */
export async function poster(src, title) {
  const img = await loadImage(src);
  const c = canvasOf(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const L = posterLayout(c.width, c.height, title);
  const shade = g.createLinearGradient(0, 0, 0, L.y + L.size);
  shade.addColorStop(0, 'rgba(0,0,0,.55)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, c.width, L.y + L.size);
  g.font = `800 ${L.size}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = L.size / 8;
  g.fillText(L.text, L.x, L.y, L.maxWidth);
  return c;
}

/** Phone spin: the middle 9:16 of one spin frame. */
export async function vertical(src) {
  const img = await loadImage(src);
  const r = verticalCrop(img.width, img.height);
  const c = canvasOf(r.width, r.height);
  c.getContext('2d').drawImage(img, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return c;
}
