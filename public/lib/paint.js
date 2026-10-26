// Pieces, colours and materials on the loaded model (the browser half of tenno.js and infer.js): finds the pieces
// (meshes and their material groups), builds a MeshPhysicalMaterial per painted piece with a subsurface term,
// picks pieces with a ray, infers car materials from the source photo, and exports the GLB and TennoGen textures.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { resolveColors, deserializeMaterial, DEFAULT_MATERIAL, TINT_SLOTS, packTintMask, packEmissiveMask, textureSet, exportWarnings, meanLuminance, hexRgb } from './tenno.js';
import { textureUrl, isCustomId } from './textures.js';
import { presetFor, stripHighlights, voteRegions, groupFaces, kmeans, clusterStats, labelClusters, mergeInference, REGION_IDS } from './infer.js';

export const pieceKey = (meshIndex, name, group = null) => `${name || 'mesh'}#${meshIndex}${group == null ? '' : `@${group}`}`;

// Every piece of a model: [{ key, mesh, group, name, faces }]. A mesh with one material is one piece; a mesh with
// material groups is one piece per group. Call after regroup() so inferred groups show up.
export function listPieces(model) {
  const out = [];
  let i = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = [].concat(o.userData.material || o.material);
    const groups = o.geometry.groups?.length ? o.geometry.groups : null;
    if (mats.length > 1 || groups) {
      (groups || mats.map((_, g) => ({ materialIndex: g }))).forEach((g, gi) => {
        const name = o.userData.groupNames?.[gi] || mats[g.materialIndex]?.name || `${o.name || 'mesh'} ${gi + 1}`;
        out.push({ key: pieceKey(i, o.name, gi), mesh: o, group: gi, name, faces: (g.count ?? o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 });
      });
    } else out.push({ key: pieceKey(i, o.name), mesh: o, group: null, name: o.name || `mesh ${i + 1}`, faces: (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 });
    i++;
  });
  return out;
}

// ---- materials ----
const SSS_GLSL = /* glsl */`
  #include <lights_fragment_begin>
  #if NUM_DIR_LIGHTS > 0
  if (sssAmount > 0.0) {
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      vec3 sL = directionalLights[i].direction;
      vec3 sHalf = normalize(sL + normal * 0.4);
      float sDot = pow(saturate(dot(geometryViewDir, -sHalf)), 2.0 / max(sssRadius, 0.1)) * 1.5;
      reflectedLight.directDiffuse += (sDot + 0.1) * sssColor * sssAmount * directionalLights[i].color * diffuseColor.rgb;
    }
  }
  #endif`;
// Realtime subsurface: a translucency term (thickness-less back scatter towards the light) added to the diffuse
// light, after the three.js subsurface scattering example. Blender gets Subsurface Weight/Radius instead.
export function withSSS(mat) {
  mat.userData.sss = { amount: { value: 0 }, radius: { value: 1 }, color: { value: new THREE.Color('#ff8866') } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.sssAmount = mat.userData.sss.amount;
    shader.uniforms.sssRadius = mat.userData.sss.radius;
    shader.uniforms.sssColor = mat.userData.sss.color;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float sssAmount; uniform float sssRadius; uniform vec3 sssColor;')
      .replace('#include <lights_fragment_begin>', SSS_GLSL);
  };
  mat.customProgramCacheKey = () => 'flatform-sss';
  return mat;
}

// Procedural detail maps: metal flake (noise normals) for car paint, a twill weave for carbon fibre.
const detailMaps = {};
export function detailNormalMap(kind, { size = 0.4, density = 0.5 } = {}) {
  const key = `${kind}:${size}:${density}`;
  if (detailMaps[key]) return detailMaps[key];
  const n = 256;
  const c = document.createElement('canvas');
  Object.assign(c, { width: n, height: n });
  const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = Math.floor(i / n);
    let nx = 0, ny = 0;
    if (kind === 'flake') {
      if (rnd() < density * 0.5) { const a = rnd() * Math.PI * 2; nx = Math.cos(a) * size; ny = Math.sin(a) * size; }
    } else { // weave: 2x2 twill of alternating ridges
      const cell = 16;
      const u = Math.floor(x / cell) % 2, v = Math.floor(y / cell) % 2;
      const t = (((u + v) % 2 ? x : y) % cell) / cell;
      const ridge = Math.sin(t * Math.PI) * 0.6;
      if ((u + v) % 2) nx = ridge - 0.3; else ny = ridge - 0.3;
    }
    img.data.set([128 + nx * 127, 128 + ny * 127, 255, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(kind === 'flake' ? 40 : 12, kind === 'flake' ? 40 : 12);
  return (detailMaps[key] = tex);
}

// The MeshPhysicalMaterial for a piece record over its original material. The piece reads the scene environment
// (envMapIntensity 1, no envMap of its own), so inferred paint, chrome and glass reflect the HDRI or backdrop.
// Library textures (ambientCG / Poly Haven, or your own import), loaded once per URL and tiled per piece.
let textureWorkspace = 'car';
export function setTextureWorkspace(w) { textureWorkspace = w; }
const loadedTextures = new Map();
function libraryMap(ref, map, mat, srgb) {
  const url = textureUrl(ref.id, map, textureWorkspace);
  let base = loadedTextures.get(url);
  if (!base) {
    base = new THREE.TextureLoader().load(url, () => { mat.needsUpdate = true; });
    loadedTextures.set(url, base);
  }
  const t = base.clone();
  t.source = base.source; // share the pixels, not the tiling
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ref.scale, ref.scale);
  t.center.set(0.5, 0.5);
  t.rotation = (ref.rotation * Math.PI) / 180;
  t.needsUpdate = true;
  return t;
}

export function pieceMaterial(piece, original, paint, cached) {
  const m = deserializeMaterial(piece.material);
  const colors = resolveColors(paint, piece);
  const mat = cached || withSSS(new THREE.MeshPhysicalMaterial());
  const tinted = piece.slot && piece.slot !== 'energy';
  const base = m.color || (tinted ? colors[piece.slot] : null);
  mat.color.set(base || '#ffffff');
  mat.map = m.textured !== false && (!base || tinted) ? original?.map || null : null; // a tint multiplies the diffuse; a set colour replaces it
  mat.normalMap = original?.normalMap || null;
  mat.roughnessMap = m.textured !== false ? original?.roughnessMap || null : null;
  mat.metalnessMap = m.textured !== false ? original?.metalnessMap || null : null;
  mat.metalness = m.metalness;
  mat.roughness = m.roughness;
  mat.clearcoat = m.clearcoat;
  mat.clearcoatRoughness = m.clearcoatRoughness;
  mat.sheen = m.sheen;
  mat.sheenRoughness = m.sheenRoughness;
  mat.sheenColor.set(m.sheenColor);
  mat.transmission = m.transmission;
  mat.ior = m.ior;
  mat.thickness = m.thickness;
  mat.opacity = m.opacity;
  mat.transparent = m.opacity < 1;
  const glow = piece.slot === 'emissive' || piece.slot === 'energy';
  mat.emissive.set(glow ? colors[piece.slot] : m.emissive);
  mat.emissiveIntensity = glow ? Math.max(m.emissiveIntensity, 2) : m.emissiveIntensity;
  mat.normalScale.set(m.normalScale, m.normalScale);
  if (m.texture) {
    mat.map = libraryMap(m.texture, 'color', mat, true);
    if (!isCustomId(m.texture.id)) {
      mat.normalMap = libraryMap(m.texture, 'normal', mat, false);
      mat.roughnessMap = libraryMap(m.texture, 'roughness', mat, false);
    }
  }
  mat.envMapIntensity = 1;
  mat.userData.sss.amount.value = m.sss;
  mat.userData.sss.radius.value = m.sssRadius;
  mat.userData.sss.color.value.set(m.sssColor);
  if (m.flake) { mat.normalMap = detailNormalMap('flake', m.flake); mat.normalScale.set(0.25, 0.25); }
  if (m.weave) { mat.normalMap = detailNormalMap('weave'); mat.normalScale.set(0.5, 0.5); }
  mat.name = piece.name;
  mat.userData.made = true;
  mat.needsUpdate = true;
  return mat;
}

// Does a piece record change how it looks (so it needs its own material)?
export const painted = (p) => Boolean(p && (p.material || p.slot || (p.colors && Object.keys(p.colors).length) || p.region));

// "Select similar" in the inspector card: the other pieces that started with the same material (by name when it has
// one), so one colour change can reach all of them. pieces: listPieces(). Returns keys, the clicked piece first.
export function similarPieces(pieces, key) {
  const matOf = (p) => [].concat(p.mesh.userData.material || p.mesh.material)[p.group ?? 0];
  const me = pieces.find((p) => p.key === key);
  if (!me) return [];
  const m0 = matOf(me);
  const same = (p) => { const m = matOf(p); return m === m0 || Boolean(m0?.name && m?.name === m0.name); };
  return [key, ...pieces.filter((p) => p.key !== key && same(p)).map((p) => p.key)];
}

// A hidden piece's face group (Hide in the inspector card): drawn with nothing. A hidden whole mesh is just not visible.
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

// Applies paint.pieces to the model: painted pieces get their physical material, the rest keep what they have.
export function applyPaint(model, paint, cache) {
  for (const p of listPieces(model)) {
    const rec = paint?.pieces?.[p.key];
    const o = p.mesh;
    const current = [].concat(o.material);
    const original = [].concat(o.userData.material);
    if (p.group == null) o.visible = !rec?.hidden;
    if (!painted(rec) && !(rec?.hidden && p.group != null)) continue;
    const idx = p.group ?? 0;
    const orig = original[Math.min(idx, original.length - 1)];
    const mat = rec.hidden ? HIDDEN : pieceMaterial({ ...rec, name: rec.name || p.name }, orig, paint, cache.get(p.key));
    if (!rec.hidden) cache.set(p.key, mat);
    if (p.group == null && !Array.isArray(o.material)) o.material = mat;
    else {
      const list = Array.isArray(o.material) ? [...current] : o.geometry.groups.map((g) => current[Math.min(g.materialIndex, current.length - 1)]);
      list[idx] = mat;
      o.material = list;
    }
  }
}

// ---- picking ----
export function pickPiece(model, camera, ndcX, ndcY) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); }); // a hidden part can't be clicked: what is behind it can
  const hit = ray.intersectObjects(meshes, false).find((h) => [].concat(h.object.material)[h.face?.materialIndex ?? 0]?.visible !== false);
  if (!hit) return null;
  const pieces = listPieces(model).filter((p) => p.mesh === hit.object);
  if (pieces.length === 1 && pieces[0].group == null) return pieces[0].key;
  const gi = hit.object.geometry.groups?.length ? hit.object.geometry.groups.findIndex((g) => hit.faceIndex * 3 >= g.start && hit.faceIndex * 3 < g.start + g.count) : hit.face?.materialIndex ?? 0;
  return pieces.find((p) => p.group === Math.max(0, gi))?.key || pieces[0]?.key || null;
}

// ---- regrouping a mesh's faces into pieces (inference on single-mesh scans) ----
// paint.groups[meshKey] = { labels: base64 Uint8 per face, names: [label per group index] }.
export function regroup(model, paint) {
  let i = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const key = pieceKey(i++, o.name);
    const g = paint?.groups?.[key];
    if (!g || !o.geometry.index) return;
    if (o.userData.grouped === g.labels) return;
    const faceIdx = Uint8Array.from(atob(g.labels), (c) => c.charCodeAt(0));
    const labels = Array.from(faceIdx, (v) => (v === 255 ? null : g.names[v]));
    const source = o.userData.sourceIndex || (o.userData.sourceIndex = o.geometry.index.array.slice());
    const { index, groups } = groupFaces(source, labels);
    o.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    o.geometry.clearGroups();
    for (const grp of groups) o.geometry.addGroup(grp.start, grp.count, groups.indexOf(grp));
    o.userData.groupNames = groups.map((grp) => grp.label || 'unlabelled');
    o.userData.grouped = g.labels;
    const mats = [].concat(o.userData.material || o.material);
    o.material = groups.map(() => mats[0]);
  });
}

// ---- car material inference from the photo ----
// photo: an HTMLImageElement of the source photo. camera: the car-view camera (frame 0). infer: async (stats, dataUrl)
// → { labels, source, note } (the server, with its vision model or fallback). Returns the new paint.
export async function inferFromPhoto(model, camera, photo, paint, infer) {
  const W = 256;
  const H = Math.max(1, Math.round((photo.naturalHeight / photo.naturalWidth) * W));
  const c = document.createElement('canvas');
  Object.assign(c, { width: W, height: H });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(photo, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  // Project every face centroid through the camera; the nearest face per pixel owns it (a tiny z-buffer).
  camera.updateMatrixWorld();
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const owner = new Int32Array(W * H).fill(-1);
  const faces = []; // { piece, mesh, face, pixel, depth }
  const pieces = listPieces(model);
  const v = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  for (const p of pieces) {
    const geo = p.mesh.geometry;
    const pos = geo.attributes.position;
    const index = geo.index?.array;
    const grp = p.group != null && geo.groups[p.group];
    const start = grp ? grp.start : 0;
    const count = grp ? grp.count : index ? index.length : pos.count;
    for (let k = start; k < start + count; k += 3) {
      const [i0, i1, i2] = index ? [index[k], index[k + 1], index[k + 2]] : [k, k + 1, k + 2];
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); d.fromBufferAttribute(pos, i2);
      v.copy(a).add(b).add(d).multiplyScalar(1 / 3).applyMatrix4(p.mesh.matrixWorld);
      const depth = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const pxX = Math.min(W - 1, Math.floor(((v.x + 1) / 2) * W));
      const pxY = Math.min(H - 1, Math.floor(((1 - v.y) / 2) * H));
      const pi = pxY * W + pxX;
      const f = faces.push({ piece: p.key, mesh: p.mesh, face: (k - (index ? 0 : 0)) / 3, pixel: pi, depth }) - 1;
      if (depth < zbuf[pi]) { zbuf[pi] = depth; owner[pi] = f; }
    }
  }
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) if (owner[i] >= 0) mask[i] = 1;
  const { labels: clusterOf, centres } = kmeans(px, mask, 8);
  const stats = clusterStats(clusterOf, centres, W, H);
  const answer = await infer(stats, c.toDataURL('image/png'));
  const clusterLabels = answer.labels;
  const labelAt = (pi) => (clusterOf[pi] >= 0 ? clusterLabels[clusterOf[pi]] : null);
  // Visible faces (within 2 % of the z-buffer) vote for their piece and keep their own label.
  const samples = [];
  const faceLabel = new Map(); // mesh → Map(face → label)
  for (const f of faces) {
    if (f.depth > zbuf[f.pixel] * 1.02) continue;
    const l = labelAt(f.pixel);
    if (!l) continue;
    samples.push({ piece: f.piece, label: l.label, weight: l.confidence });
    if (!faceLabel.has(f.mesh)) faceLabel.set(f.mesh, new Map());
    faceLabel.get(f.mesh).set(f.face, l.label);
  }
  const votes = voteRegions(samples);
  // The paint colour: de-lit median of the pixels in paint-labelled clusters; calipers likewise.
  const sampled = {};
  for (const region of ['paint', 'caliper']) {
    const m = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) if (mask[i] && labelAt(i)?.label === region) m[i] = 1;
    if (m.some(Boolean)) sampled[region] = stripHighlights(px, m).color;
  }
  let next = { ...paint, pieces: { ...paint.pieces }, groups: { ...paint.groups }, inference: { source: answer.source, note: answer.note || '', at: new Date().toISOString() } };
  // Single-shell scans: split the mesh into one piece per region by face, then vote per new piece.
  const single = pieces.length <= 2 && pieces.every((p) => p.group == null);
  if (single) {
    let mi = 0;
    for (const p of pieces) {
      const key = pieceKey(mi++, p.mesh.name);
      const fl = faceLabel.get(p.mesh);
      const geo = p.mesh.geometry;
      if (!fl || !geo.index) continue;
      const nFaces = geo.index.count / 3;
      const majority = votes[p.key]?.region || 'paint';
      const names = REGION_IDS;
      const bytes = new Uint8Array(nFaces);
      for (let f = 0; f < nFaces; f++) bytes[f] = names.indexOf(fl.get(f) || majority);
      next.groups[key] = { labels: b64(bytes), names };
    }
    regroup(model, next);
    const regrouped = {};
    for (const p of listPieces(model)) {
      const label = p.mesh.userData.groupNames?.[p.group];
      if (!label || label === 'unlabelled') continue;
      const own = samples.filter((s) => s.piece === pieceKey(pieces.findIndex((q) => q.mesh === p.mesh), p.mesh.name) && s.label === label);
      regrouped[p.key] = { region: label, confidence: own.length ? Math.min(1, own.reduce((t, s) => t + s.weight, 0) / own.length) : 0.5, flagged: own.length < 3 };
      next.pieces[p.key] = { ...(next.pieces[p.key] || {}), name: next.pieces[p.key]?.name || REGION_LABEL(label) };
    }
    next.pieces = mergeInference(next.pieces, regrouped);
  } else next.pieces = mergeInference(next.pieces, votes);
  // Materials: the region's preset, unless the user set one.
  for (const [key, rec] of Object.entries(next.pieces)) {
    if (!rec.region || rec.region.user || rec.material?.user) continue;
    next.pieces[key] = { ...rec, material: { ...presetFor(rec.region.label, sampled[rec.region.label]), textured: false, inferred: true } };
  }
  return next;
}
// Base64 of a byte array without spreading it into arguments (100k faces would overflow the stack).
function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}
const REGION_LABEL = (id) => ({ paint: 'Body paint', chrome: 'Chrome trim', glass: 'Glass', rubber: 'Tyres', carbon: 'Carbon fibre', caliper: 'Brake calipers', lights: 'Lights', grille: 'Grille' })[id] || id;

// "Revert to photo texture": drops inferred regions, materials and face groups, keeps user-set ones.
export function revertInference(model, paint) {
  const pieces = {};
  for (const [k, p] of Object.entries(paint.pieces || {})) {
    const keep = { ...p };
    if (keep.region && !keep.region.user) delete keep.region;
    if (keep.material?.inferred) delete keep.material;
    if (painted(keep) || keep.name || keep.section) pieces[k] = keep;
  }
  model.traverse((o) => {
    if (!o.isMesh || !o.userData.sourceIndex) return;
    o.geometry.setIndex(new THREE.BufferAttribute(o.userData.sourceIndex, 1));
    o.geometry.clearGroups();
    delete o.userData.groupNames;
    delete o.userData.grouped;
    o.material = o.userData.material;
  });
  return { ...paint, pieces, groups: {}, inference: null };
}

// ---- exports ----
// UV-space mask of a piece's faces at size×size (1 where the piece is).
export function uvMask(piece, size) {
  const c = document.createElement('canvas');
  Object.assign(c, { width: size, height: size });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  const geo = piece.mesh.geometry;
  const uv = geo.attributes.uv;
  if (!uv) return new Uint8Array(size * size);
  const index = geo.index?.array;
  const grp = piece.group != null && geo.groups[piece.group];
  const start = grp ? grp.start : 0;
  const count = grp ? grp.count : index ? index.length : uv.count;
  g.beginPath();
  for (let k = start; k < start + count; k += 3) {
    for (let j = 0; j < 3; j++) {
      const i = index ? index[k + j] : k + j;
      const x = uv.getX(i) * size, y = (1 - uv.getY(i)) * size;
      if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }
  g.fill();
  const data = g.getImageData(0, 0, size, size).data;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) if (data[i * 4] > 127) mask[i] = 1;
  return mask;
}

const toBlob = (canvas) => new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not encode PNG'))), 'image/png'));
function rgbaCanvas(data, w, h) {
  const c = document.createElement('canvas');
  Object.assign(c, { width: w, height: h });
  c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}
function paintedCanvas(size, pieces, masks, valueOf, base) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([...base, 255], i * 4);
  for (const p of pieces) {
    const v = valueOf(p);
    if (!v) continue;
    const m = masks.get(p.key);
    for (let i = 0; i < m.length; i++) if (m[i]) data.set([...v, 255], i * 4);
  }
  return { data, canvas: rgbaCanvas(data, size, size) };
}

// The TennoGen texture set for a part: [{ name, blob }], plus warnings. Pieces are the model's pieces with their
// paint records; the diffuse comes from the model's own texture where it has one, with painted pieces filled in.
export async function exportTennoGen(model, paint, { part = 'Body', altHelmet = false } = {}) {
  const pieces = listPieces(model).map((p) => ({ ...p, rec: paint.pieces?.[p.key] || {} }));
  const set = textureSet(part, { altHelmet });
  const sizeOf = (map) => set.find((s) => s.map === map);
  const maskCache = new Map(); // size → Map(key → mask)
  const masksAt = (size) => {
    if (!maskCache.has(size)) maskCache.set(size, new Map(pieces.map((p) => [p.key, uvMask(p, size)])));
    return maskCache.get(size);
  };
  const files = [];
  // _t and _e at 1024 (or the alt helmet size: use the width).
  const tSize = sizeOf('t').width;
  const tMasks = masksAt(tSize);
  const tint = packTintMask(tSize, tSize, pieces.map((p) => ({ slot: p.rec.slot, mask: tMasks.get(p.key) })));
  files.push({ name: `${part}_t.png`, blob: await toBlob(rgbaCanvas(tint.data, tSize, tSize)) });
  files.push({ name: `${part}_e.png`, blob: await toBlob(rgbaCanvas(packEmissiveMask(tSize, tSize, pieces.map((p) => ({ slot: p.rec.slot, mask: tMasks.get(p.key) }))), tSize, tSize)) });
  // _d: the baked texture, with set colours filled over their pieces.
  const dSize = sizeOf('d').width;
  const dMasks = masksAt(dSize);
  const first = [].concat(pieces[0]?.mesh.userData.material || [])[0];
  const dc = document.createElement('canvas');
  Object.assign(dc, { width: dSize, height: dSize });
  const dg = dc.getContext('2d', { willReadFrequently: true });
  dg.fillStyle = '#808080';
  dg.fillRect(0, 0, dSize, dSize);
  if (first?.map?.image) { dg.save(); dg.translate(0, dSize); dg.scale(1, first.map.flipY ? -1 : 1); dg.drawImage(first.map.image, 0, first.map.flipY ? 0 : -dSize, dSize, dSize); dg.restore(); }
  const dImg = dg.getImageData(0, 0, dSize, dSize);
  let metalWeight = 0, total = 0;
  for (const p of pieces) {
    const m = deserializeMaterial(p.rec.material);
    const colors = resolveColors(paint, p.rec);
    const fill = m.color ? hexRgb(m.color) : p.rec.slot && TINT_SLOTS.includes(p.rec.slot) ? hexRgb(colors[p.rec.slot]) : null;
    const mask = dMasks.get(p.key);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; if (fill) dImg.data.set([...fill, 255], i * 4); }
    metalWeight += m.metalness * n;
    total += n;
  }
  dg.putImageData(dImg, 0, 0);
  files.push({ name: `${part}_d.png`, blob: await toBlob(dc) });
  // _n flat (or the model's normal map), _r roughness, _s metalness as greys per piece.
  const nSize = sizeOf('n').width;
  const nc = document.createElement('canvas');
  Object.assign(nc, { width: nSize, height: nSize });
  const ng = nc.getContext('2d');
  ng.fillStyle = 'rgb(128,128,255)';
  ng.fillRect(0, 0, nSize, nSize);
  if (first?.normalMap?.image) ng.drawImage(first.normalMap.image, 0, 0, nSize, nSize);
  files.push({ name: `${part}_n.png`, blob: await toBlob(nc) });
  const grey = (v) => { const g = Math.round(v * 255); return [g, g, g]; };
  const rMasks = masksAt(sizeOf('r').width);
  files.push({ name: `${part}_r.png`, blob: await toBlob(paintedCanvas(sizeOf('r').width, pieces, rMasks, (p) => grey(deserializeMaterial(p.rec.material).roughness), grey(DEFAULT_MATERIAL.roughness)).canvas) });
  files.push({ name: `${part}_s.png`, blob: await toBlob(paintedCanvas(sizeOf('s').width, pieces, rMasks, (p) => grey(deserializeMaterial(p.rec.material).metalness), [0, 0, 0]).canvas) });
  const warnings = exportWarnings({ used: tint.used, albedo: { luminance: meanLuminance(dImg.data), metal: total ? metalWeight / total > 0.5 : false } });
  return { files, warnings };
}

// GLB with one clean, named material slot per section+slot (or piece), as the TennoGen tooling expects.
// The GLB as you see it: mirror applied (the geometry already is), decals included (pass studio.decals).
export async function exportGlb(model, paint, decals = null) {
  const names = new Map();
  const stashed = new Map(); // the mirror tool's original geometry, kept out of the GLB's extras
  model.traverse((o) => { if (o.userData.origGeometry) { stashed.set(o, o.userData.origGeometry); delete o.userData.origGeometry; } });
  for (const p of listPieces(model)) {
    const rec = paint.pieces?.[p.key];
    const mats = [].concat(p.mesh.material);
    const mat = mats[p.group ?? 0];
    if (!mat) continue;
    const section = paint.sections?.find((s) => s.id === rec?.section)?.name;
    const name = [section, rec?.slot || (rec?.region?.label), rec?.name || p.name].filter(Boolean).join('_').replace(/[^\w-]+/g, '_');
    names.set(mat, mat.name);
    mat.name = name;
  }
  try {
    const out = await new GLTFExporter().parseAsync(decals?.children.length ? [model, decals] : model, { binary: true });
    return new Blob([out], { type: 'model/gltf-binary' });
  } finally {
    for (const [mat, name] of names) mat.name = name;
    for (const [o, g] of stashed) o.userData.origGeometry = g;
  }
}
