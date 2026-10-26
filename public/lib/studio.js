// The Three.js studio shared by Review, the scene composer and the in-app renderer.
//
// Conventions (also used by render/blender_turntable.py):
// - Metres, Y up. Every car is normalised on load: length along Z, centred on the origin, tyres on y = 0, and scaled
//   so its length is CAR_LENGTH ("Fit"), so every car in the fleet matches. Tripo lays cars along X with the nose
//   on +X, so auto-orient turns +X to +Z (towards the camera); "Flip" covers scans that come the other way round.
// - The camera is fitted to the car's footprint, so the car fills the same share of every frame at every turn.
// - Yaw 0° = nose straight at the camera. Positive yaw turns the car clockwise seen from above, so 30° (the default
//   "turn") is the front ¾ view with the nose towards the left of the frame. Turntable frame i is at turn + 5°·i.
// - The camera, lights and studio never move during a turntable; only the car turns.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeLook, effectsFor, hdriUrl, lookNeedsRebuild } from './look.js';
import { Post, PathTraced, TONE } from './post.js';
import { applyPaint, regroup, pickPiece, listPieces } from './paint.js';
import { applyMotion } from './rig.js';
import { mirrorAttributes, depthRange, boneWeights, heat } from './model-tools.js';
import { samplePath, skyAt, normalizePath } from './camera-path.js';
import { STEP, DEFAULT_LIGHTING, DEFAULT_GLASS, PLATES, plateUrl, plateThumb, plateCamera, CAR_LENGTH, hfovOf, isCarShape, modelScale, fitDistance, frameOrbit } from './pipeline.js';

RectAreaLightUniformsLib.init();

export { CAR_LENGTH };
export const RING = '#ff7a66'; // the accent colour of the app
export const GOLD = '#f2b56b'; // the showroom's floor ring
export const CAMERAS = {
  front34: { label: 'Front ¾', turn: 30, elevation: 13, lens: 50, height: 'eye height' },
  side: { label: 'Side', turn: 90, elevation: 6, lens: 50, height: 'eye height' },
  rear34: { label: 'Rear ¾', turn: 150, elevation: 13, lens: 50, height: 'eye height' },
  low: { label: 'Low hero', turn: 30, elevation: 2.5, lens: 35, height: 'low' },
};
// 'ring' was called 'gold' before v0.4; the server renames it in saved scenes and settings.
// Showroom comes first: it is the default scene and Dud Rents' house look. Backplate scenes (PLATES in pipeline.js)
// put a fixed photo behind the car; the rest are built in 3D.
export const PRESETS = {
  ...Object.fromEntries(Object.entries(PLATES).map(([key, p]) => [key, { label: p.label, note: p.note, plate: true, thumb: plateThumb(key) }])),
  ring: { label: 'Escalade ring studio', note: 'Reflective floor · coral ring · side light bars' },
  transparent: { label: 'Transparent', note: 'RGBA PNG with soft contact shadow' },
  cyclorama: { label: 'White cyclorama', note: 'Seamless white, soft top light' },
  miami: { label: 'Miami street at night', note: 'Add your Miami HDRI' },
  custom: { label: 'Your backdrop or HDRI', note: 'Upload a JPG, PNG, EXR or HDR' },
};
// Light intensities each preset uses when "Match lighting to scene" is on.
const MATCHED = {
  ring: { key: 1.3, fill: 0.3, rim: 1.4 },
  showroom: { key: 1.1, fill: 0.35, rim: 1.3 },
  transparent: { key: 1.6, fill: 0.6, rim: 0.9 },
  cyclorama: { key: 1.1, fill: 0.6, rim: 0.4 },
  backdrop: { key: 0.5, fill: 0.15, rim: 0.4 },
};

export function defaultScene(settings = {}) {
  return {
    preset: settings.defaultScene && settings.defaultScene !== 'transparent' ? settings.defaultScene : 'showroom',
    modeled: false, // Showroom only: the modeled room instead of the photo
    backdrop: null, x: 0, y: 0, snap: true, turn: 30, scale: 1, sameSize: true,
    camera: 'front34', lens: 50, matchLighting: true, key: 1.3, fill: 0.3, rim: 1.4,
    reflection: 0.7, shadow: 0.5, autoOrient: true, center: true, flip: false,
    // Camera view mode. 'car': the preset above (matched to the photo, eye level), unchanged since v0.4. 'free': an
    // orbit camera, kept in orbit = { position, target } so renders use it too. fit: 'all' after "Frame all" in car view.
    view: 'car', orbit: null, fit: 'footprint',
    // v0.5: the scene look (look.js: background, HDRI, lights, AO, tone mapping, effects) and the paint project
    // (tenno.js: pieces, colours, materials). null = defaults = exactly the v0.4 look.
    look: null, paint: null,
  };
}
export const VIEWS = { car: 'Car view', free: 'Free roam' };
export const lookOf = (preset) => (preset === 'transparent' || preset === 'showroom' ? preset : 'studio');
// Share of the frame width the car's footprint diagonal spans (the widest it can look at any turn).
const FILL = { wide: 0.7, square: 0.84 };

// Light colour for a colour temperature in kelvin (Tanner Helland's fit of the blackbody curve), as sRGB 0-1.
const kelvinHex = (k) => new THREE.Color().setRGB(...kelvinColor(k), THREE.SRGBColorSpace);
export function kelvinColor(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255);
}

// Glass. Meshes or materials named like glass get a real glass material. Tripo exports one mesh with one baked
// texture, so there the glass is found in the textures instead: dark, unsaturated, glossy pixels.
// ponytail: colour heuristic, glossy black paint and trim match too; part-segmented models would make it exact.
const GLASS_NAME = /glass|window|windshield|windscreen/i;
const glassScans = new WeakMap(); // original material -> { w, h, base, mr, mask } or null
function pixels(image, w, h) {
  const c = document.createElement('canvas');
  Object.assign(c, { width: w, height: h });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}
function scanGlass(m) {
  if (!glassScans.has(m)) {
    let scan = null;
    const img = m.map?.image;
    const mrImg = m.roughnessMap?.image;
    if (img && mrImg && typeof document !== 'undefined') {
      const w = img.width;
      const h = img.height;
      const base = pixels(img, w, h);
      const mr = pixels(mrImg, w, h);
      const mask = new Uint8Array(w * h);
      let count = 0;
      for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        const r = base.data[p], g = base.data[p + 1], b = base.data[p + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 80 && Math.max(r, g, b) - Math.min(r, g, b) < 48 && mr.data[p + 1] * m.roughness < 110) { mask[i] = 1; count++; }
      }
      if (count > mask.length * 0.002) scan = { w, h, base, mr, mask };
    }
    glassScans.set(m, scan);
  }
  return glassScans.get(m);
}
function canvasTexture(src, data) {
  const c = document.createElement('canvas');
  Object.assign(c, { width: data.width, height: data.height });
  c.getContext('2d').putImageData(data, 0, 0);
  const t = src.clone();
  t.source = new THREE.TextureSource(c);
  t.needsUpdate = true;
  return t;
}
// The scanned material with its glass pixels tinted, glossy and non-metal. Tripo scans are solid shells (nothing
// behind the glass), so this glass stays opaque: opacity sets how much the tint covers the baked view inside.
function tintedGlass(m, glass) {
  const scan = scanGlass(m);
  if (!scan) return null;
  const tint = new THREE.Color(glass.tint);
  const [tr, tg, tb] = [tint.r, tint.g, tint.b].map((v) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255));
  const base = new ImageData(new Uint8ClampedArray(scan.base.data), scan.w, scan.h);
  const mr = new ImageData(new Uint8ClampedArray(scan.mr.data), scan.w, scan.h);
  const a = glass.opacity;
  const gloss = Math.round((0.05 * 255) / Math.max(m.roughness, 0.05)); // roughness 0.05 after the factor
  for (let i = 0, p = 0; i < scan.mask.length; i++, p += 4) {
    if (!scan.mask[i]) continue;
    base.data[p] += (tr - base.data[p]) * a;
    base.data[p + 1] += (tg - base.data[p + 1]) * a;
    base.data[p + 2] += (tb - base.data[p + 2]) * a;
    mr.data[p + 1] = gloss;
    mr.data[p + 2] = 0; // not metal
  }
  const userData = m.userData;
  m.userData = {}; // clone() would JSON-copy the stashed texture
  const out = m.clone();
  m.userData = userData;
  out.map = canvasTexture(m.map, base);
  out.roughnessMap = canvasTexture(m.roughnessMap, mr);
  if (m.metalnessMap) out.metalnessMap = m.metalnessMap === m.roughnessMap ? out.roughnessMap : m.metalnessMap;
  out.userData = { map: out.map, made: true };
  return out;
}
function glassMaterial(glass) {
  return new THREE.MeshPhysicalMaterial({
    color: glass.tint, metalness: 0, roughness: 0.05, ior: 1.5, transmission: 1 - glass.opacity, thickness: 0.01,
    userData: { made: true },
  });
}
export const aspectOf = (preset) => (preset === 'transparent' ? 1 : 4 / 3);
const needsBackdrop = (preset) => preset === 'miami' || preset === 'custom';
// The plate whose camera a scene uses (the modeled showroom keeps the photo's camera, so the toggle doesn't jump).
const plateOf = (s) => PLATES[s.preset] || null;
const usesPhoto = (s) => Boolean(PLATES[s.preset]) && !(s.preset === 'showroom' && s.modeled);

// Glossy dark floor: a planar mirror softened by a small blur and faded with distance ("roughness blend").
const FloorShader = {
  name: 'FlatformFloor',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    strength: { value: 0.6 }, blur: { value: 1.6 }, texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float blur;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vUv.xy / vUv.w;
      vec3 sum = vec3(0.0);
      float total = 0.0;
      for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
        float k = exp(-float(x * x + y * y) / 8.0);
        sum += texture2D(tDiffuse, uv + vec2(float(x), float(y)) * texel * blur).rgb * k;
        total += k;
      }
      float fade = 1.0 - smoothstep(4.0, 16.0, length(vWorld.xz));
      gl_FragColor = vec4(color + sum / total * strength * fade, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

// Floor reflection over a photo: only the mirrored car, blurred and faded, laid over the plate's own floor.
const GlossShader = {
  name: 'FlatformGloss',
  uniforms: { ...FloorShader.uniforms },
  vertexShader: FloorShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float blur;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vUv.xy / vUv.w;
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
        float k = exp(-float(x * x + y * y) / 8.0);
        sum += texture2D(tDiffuse, uv + vec2(float(x), float(y)) * texel * blur) * k;
        total += k;
      }
      sum /= total;
      float fade = 1.0 - smoothstep(1.0, 4.5, length(vWorld.xz));
      gl_FragColor = vec4(sum.rgb / max(sum.a, 0.001), sum.a * strength * fade);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

// Soft additive glow around a ring (radius in local XY) or along a bar (local x).
function glowMaterial(kind, color, width, strength, radius = 0) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, width: { value: width }, strength: { value: strength }, radius: { value: radius } },
    vertexShader: 'varying vec2 vPos; void main() { vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 color; uniform float width; uniform float strength; uniform float radius; varying vec2 vPos;
      void main() {
        float d = ${{ ring: '(length(vPos) - radius) / width', bar: 'vPos.x / width', panel: 'vPos.y / width' }[kind]};
        float edge = ${kind === 'panel' ? '1.0 - smoothstep(2.5, 6.0, abs(vPos.x))' : '1.0'};
        gl_FragColor = vec4(color * strength * exp(-d * d) * edge, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
}
const emissive = (color, intensity) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) });

// The lighting the car paint reflects in the ring studio: dark room, overhead softbox, two light bars, the ring.
function ringEnvironment() {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(26, 14, 26), new THREE.MeshBasicMaterial({ color: 0x030303, side: THREE.BackSide }));
  room.position.y = 6;
  env.add(room);
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; env.add(m); };
  add(new THREE.PlaneGeometry(9, 4), emissive('#ffffff', 5), 0, 8, -1, Math.PI / 2);
  add(new THREE.BoxGeometry(0.5, 7, 0.5), emissive('#ffffff', 9), -7, 3.6, -3);
  add(new THREE.BoxGeometry(0.5, 7, 0.5), emissive('#ffffff', 9), 7, 3.6, -3);
  add(new THREE.PlaneGeometry(6, 2.5), emissive('#fff6ea', 0.9), 0, 2.2, 11);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.08, 8, 96), emissive(RING, 2));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  env.add(ring);
  return env;
}

// What the paint reflects in the showroom: a dark room, a big ceiling softbox, two light bars, a front softbox.
function showroomEnvironment() {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 30), new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.BackSide }));
  room.position.y = 5;
  env.add(room);
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; env.add(m); };
  add(new THREE.PlaneGeometry(10, 6), emissive('#fffaf2', 4), 0, 8, 0, Math.PI / 2);
  add(new THREE.BoxGeometry(0.4, 6, 0.4), emissive('#ffffff', 7), -7, 3, -3);
  add(new THREE.BoxGeometry(0.4, 6, 0.4), emissive('#ffffff', 7), 7, 3, -3);
  add(new THREE.PlaneGeometry(8, 2.5), emissive('#fff6ea', 0.7), 0, 2.2, 11);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.05, 8, 96), emissive(GOLD, 1.2));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  env.add(ring);
  return env;
}

// Contact shadow: renders the car from below into a small target, blurs it and lays it on the floor
// (after the three.js "shadow contact" example). Updated every frame because the car turns.
class ContactShadow {
  constructor(size = 9, res = 1024, height = 2.4) {
    this.group = new THREE.Group();
    this.rt = new THREE.WebGLRenderTarget(res, res);
    this.rtBlur = new THREE.WebGLRenderTarget(res, res);
    this.rt.texture.generateMipmaps = this.rtBlur.texture.generateMipmaps = false;
    const geo = new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, depthWrite: false, opacity: 0.7 }));
    this.plane.renderOrder = 1;
    this.plane.scale.y = -1;
    this.blurPlane = new THREE.Mesh(geo);
    this.blurPlane.visible = false;
    this.blurPlane.layers.set(1);
    this.camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.camera.rotation.x = Math.PI / 2;
    this.camera.layers.set(1);
    this.group.add(this.plane, this.blurPlane, this.camera);
    this.group.position.y = 0.004;
    this.depth = new THREE.MeshDepthMaterial();
    this.depth.depthTest = this.depth.depthWrite = false;
    this.depth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * 1.15 );');
    };
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.hBlur.depthTest = this.vBlur.depthTest = false;
  }

  blurPass(renderer, amount) {
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
  }

  update(renderer, scene, softness) {
    const background = scene.background;
    const clear = renderer.getClearAlpha();
    scene.background = null;
    scene.overrideMaterial = this.depth;
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = null;
    const blur = 1 + softness * 6;
    this.blurPass(renderer, blur);
    this.blurPass(renderer, blur * 0.4);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(clear);
    scene.background = background;
  }

  dispose() {
    this.rt.dispose();
    this.rtBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.depth.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
  }
}

// A vertical two-colour gradient as a background texture (cached by its colours).
const gradients = {};
function gradientTexture(top, bottom) {
  const key = `${top}:${bottom}`;
  if (!gradients[key]) {
    const c = document.createElement('canvas');
    Object.assign(c, { width: 4, height: 256 });
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    gradients[key] = tex;
  }
  return gradients[key];
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });
  obj.dispose?.();
}

export class Studio {
  constructor(canvas, { preserveDrawingBuffer = false } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true; // the key light shades the car itself
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.1, 400);
    this.pivot = new THREE.Group(); // turns for the turntable
    this.stage = new THREE.Group(); // the preset's props
    this.scene.add(this.pivot, this.stage);
    this.shadow = new ContactShadow();
    this.scene.add(this.shadow.group);
    this.lights = { key: new THREE.DirectionalLight(0xfff3e2), fill: new THREE.DirectionalLight(0xdfe8ff), rim: new THREE.DirectionalLight(0xffffff) };
    this.lights.key.position.set(-6, 8, 7);
    this.lights.fill.position.set(8, 3, 6);
    this.lights.rim.position.set(1, 6, -10);
    this.baseRig = Object.fromEntries(Object.entries(this.lights).map(([k, l]) => [k, { color: l.color.getHex(), position: l.position.toArray() }]));
    const key = this.lights.key;
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 30 });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.scene.add(...Object.values(this.lights));
    this.rig = { lighting: DEFAULT_LIGHTING, glass: DEFAULT_GLASS }; // the Render step's light rig and glass
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envs = {};
    this.builds = 0; // a newer preset wins over one that is still loading its HDRI
    this.state = defaultScene();
    this.pieceMats = new Map(); // piece key → its MeshPhysicalMaterial (paint.js)
    this.hdris = {}; // loaded HDRIs by file
    this.ptDirty = true; // the path tracer must rebuild its scene
    this.frame = 0;
    this.width = canvas.width;
    this.height = canvas.height;
    this.frameRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }

  env(name) {
    this.envs[name] ||= this.pmrem.fromScene({ ring: ringEnvironment, showroom: showroomEnvironment }[name]?.() || new RoomEnvironment(), 0.04).texture;
    return this.envs[name];
  }

  async load(url) {
    // Decoders for compressed GLBs ship with three and are served locally.
    const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    draco.dispose();
    if (this.model) { this.pivot.remove(this.model); disposeTree(this.model); }
    this.model = gltf.scene;
    this.mirrorKey = "";
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.layers.enable(1); // seen by the contact shadow camera
      o.castShadow = o.receiveShadow = true;
      for (const m of [].concat(o.material)) m.userData.map = m.map; // for "textures off"
      o.userData.material = o.material;
    });
    this.pivot.add(this.model);
    this.pieceMats.clear();
    this.applyModel();
    this.applyPaint();
    this.applyCamera();
    this.ptDirty = true;
    return this.model;
  }

  // Pieces, colours and materials (state.paint, see paint.js). Starts from the glass pass so a reverted piece
  // goes back to its original or tinted-glass material.
  applyPaint() {
    if (!this.model) return;
    this.applyGlass();
    regroup(this.model, this.state.paint);
    applyPaint(this.model, this.state.paint, this.pieceMats);
    this.ptDirty = true;
  }
  pieces() { return this.model ? listPieces(this.model) : []; }
  // The piece under a canvas point (CSS px), or null.
  pick(x, y) {
    if (!this.model) return null;
    return pickPiece(this.model, this.camera, (x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  // The Render step's light rig and glass ({ lighting, glass } as saved in settings). Missing parts keep defaults.
  setRig({ lighting, glass } = {}) {
    const next = { lighting: { ...DEFAULT_LIGHTING, ...lighting }, glass: { ...DEFAULT_GLASS, ...glass } };
    const glassChanged = JSON.stringify(next.glass) !== JSON.stringify(this.rig.glass);
    this.rig = next;
    this.applyLights();
    if (glassChanged) this.applyPaint();
  }

  applyGlass() {
    const glass = this.rig.glass;
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      const original = o.userData.material;
      for (const m of [].concat(o.material)) {
        if (!m.userData.made) continue;
        if (m.map && m.map !== original.map) m.map.dispose();
        if (m.roughnessMap && m.roughnessMap !== original.roughnessMap) m.roughnessMap.dispose();
        m.dispose();
      }
      o.material = original;
      if (!glass.on) return;
      const list = [].concat(original);
      if (GLASS_NAME.test(o.name)) o.material = Array.isArray(original) ? list.map(() => glassMaterial(glass)) : glassMaterial(glass);
      else if (list.some((m) => GLASS_NAME.test(m.name))) {
        const swapped = list.map((m) => (GLASS_NAME.test(m.name) ? glassMaterial(glass) : m));
        o.material = Array.isArray(original) ? swapped : swapped[0];
      } else if (!Array.isArray(original)) o.material = tintedGlass(original, glass) || original;
    });
  }

  async setState(next) {
    const prev = this.state;
    this.state = { ...prev, ...next };
    const lookRebuild = lookNeedsRebuild(prev.look, this.state.look);
    if (!this.built || prev.preset !== this.state.preset || prev.backdrop !== this.state.backdrop || Boolean(prev.modeled) !== Boolean(this.state.modeled) || lookRebuild) await this.buildPreset();
    this.applyModel();
    this.applyLights();
    this.applyCamera();
    if (JSON.stringify(prev.paint) !== JSON.stringify(this.state.paint)) this.applyPaint();
    await this.applyLook();
  }

  // The look (look.js): background, HDRI, light preset, tone mapping, effects. Runs after the preset and the
  // scene's own lights, so with the default look nothing here changes a thing.
  async applyLook() {
    const build = this.builds;
    const look = this.look = mergeLook(this.state.look);
    const r = this.renderer;
    r.toneMapping = TONE[look.tone] ?? THREE.NeutralToneMapping;
    r.toneMappingExposure = look.exposure;
    // Background.
    const bg = look.background;
    if (bg.kind === 'solid') this.scene.background = new THREE.Color(bg.color);
    else if (bg.kind === 'gradient') this.scene.background = gradientTexture(bg.color, bg.color2);
    else if (bg.kind === 'image' && bg.image) {
      try {
        const tex = await new THREE.TextureLoader().loadAsync(`/backdrops/${encodeURIComponent(bg.image)}`);
        if (build !== this.builds) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        this.backdropTexture?.dispose();
        this.backdropTexture = tex;
        this.scene.background = tex;
        this.coverBackground();
      } catch { this.message = 'Could not load that background image'; }
    }
    // HDRI environment (and background).
    const h = look.hdri;
    this.lookHdri = { ...h };
    this.skyFile = null;
    this.dimBase = undefined;
    if (h.file) {
      try {
        const { env, tex } = await this.hdri(h.file);
        if (build !== this.builds) return;
        this.scene.environment = env;
        this.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(h.rotation), 0);
        this.scene.environmentIntensity *= h.intensity;
        if (h.background) {
          this.scene.background = tex;
          this.scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(h.rotation), 0);
          this.scene.backgroundBlurriness = h.blur;
          this.scene.backgroundIntensity = h.intensity;
        }
      } catch { this.message = 'Could not load that HDRI'; }
    } else { this.scene.environmentRotation.set(0, 0, 0); this.scene.backgroundBlurriness = 0; this.scene.backgroundIntensity = 1; }
    this.applyRig(look.lights);
    this.applyEffects();
  }

  async hdri(file) {
    if (!this.hdris[file]) {
      const url = hdriUrl(file);
      const tex = /\.exr$/i.test(url) ? await new EXRLoader().loadAsync(url) : await new HDRLoader().loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this.hdris[file] = { tex, env: this.pmrem.fromEquirectangular(tex).texture };
    }
    return this.hdris[file];
  }

  // A light preset's key/fill/rim (on, intensity, colour, azimuth, elevation, shadows, softness). 'match' = the
  // scene's own rig as applyLights set it, with the base colours and the rim's place restored.
  applyRig(lights) {
    const L = this.lights;
    if (lights.preset === 'match') {
      for (const [k, l] of Object.entries(L)) { l.visible = true; l.color.setHex(this.baseRig[k].color); }
      L.rim.position.fromArray(this.baseRig.rim.position);
      this.applyLights(); // key colour and the key/fill places come from the scene and the Render step's rig
      L.key.castShadow = true;
      L.key.shadow.radius = 3;
      return;
    }
    for (const k of ['key', 'fill', 'rim']) {
      const c = lights[k];
      const az = THREE.MathUtils.degToRad(c.azimuth);
      const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(c.elevation, 1, 89));
      L[k].visible = c.on;
      L[k].intensity = c.intensity;
      L[k].color.set(c.color);
      L[k].position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(k === 'key' ? 12 : 9);
    }
    L.key.castShadow = lights.shadows;
    L.key.shadow.radius = 1 + lights.softness * 6;
  }

  // Realtime effects for the look at the current quality (look.js effectsFor): composer passes, path tracing.
  applyEffects() {
    const look = this.look || mergeLook(this.state.look);
    const fx = this.fx = effectsFor(look);
    if (fx.composer) {
      this.post ||= new Post(this.renderer, this.scene, this.camera);
      this.post.configure(look, fx, this.width, this.height, this.renderer.getPixelRatio());
    } else if (this.post) { this.post.dispose(); this.post = null; }
    this.tracing = fx.pathTraced;
    if (this.tracing) {
      this.pt ||= new PathTraced(this.renderer);
      if (this.ptDirty) {
        this.ptDirty = false;
        this.ptBusy = true;
        this.ptReady = this.pt.setScene(this.scene, this.camera).then(() => { this.ptBusy = false; }, (e) => { this.message = `Path tracing is not available here: ${e.message}`; this.tracing = false; this.ptBusy = false; });
      } else this.pt.cameraMoved();
    } else if (this.pt) { this.pt.dispose(); this.pt = null; this.ptDirty = true; }
  }
  // Progress of the path-traced preview: samples done (0 when not tracing).
  get samples() { return this.tracing ? this.pt?.samples || 0 : 0; }

  setFrame(i) {
    this.frame = i;
    this.applyYaw();
    this.applyPathFrame();
  }

  // Camera move (camera-path.js): on a turntable frame the camera follows the saved path. t runs 0..1 over
  // the full turn. Without a path this does nothing, so plain turntables render as before.
  pathT() { return (this.frame || 0) / (360 / STEP); }
  applyPathFrame() {
    const p = this.state.cameraPath;
    if (!p?.on || !normalizePath(p).on) return;
    const c = samplePath(p, this.pathT());
    this.applyCamera();
    this.camera.position.set(...c.position);
    this.target = new THREE.Vector3(...c.target);
    this.camera.lookAt(this.target);
    this.camera.near = Math.min(this.camera.near, 0.05);
    this.camera.far = Math.max(this.camera.far, 400);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }
  // Sky playlist for frame t: turns the environment and switches HDRIs with a short dip to dark. Async because a
  // new HDRI may have to load; the render loop awaits it before drawing the frame.
  async applySkyFrame(t = this.pathT()) {
    const sky = this.state.sky;
    const h = this.lookHdri;
    if (!sky?.on || !h) return;
    const k = skyAt(sky, t);
    const file = k.file || h.file;
    if (!file) return;
    if (file !== (this.skyFile || h.file)) {
      try {
        const { env, tex } = await this.hdri(file);
        this.scene.environment = env;
        if (h.background) this.scene.background = tex;
        this.skyFile = file;
      } catch { this.message = 'Could not load that HDRI'; }
    }
    const rot = THREE.MathUtils.degToRad((h.rotation || 0) + k.rotation);
    this.scene.environmentRotation.set(0, rot, 0);
    if (h.background) { this.scene.backgroundRotation.set(0, rot, 0); this.scene.backgroundIntensity = (h.intensity ?? 1) * Math.max(0.02, k.dim); }
    this.dimBase ??= this.scene.environmentIntensity;
    this.scene.environmentIntensity = this.dimBase * Math.max(0.02, k.dim);
  }

  yaw() { return this.state.turn + (this.state.cameraPath?.on && this.state.cameraPath.spin === false ? 0 : this.frame * STEP); }
  applyYaw() { this.pivot.rotation.y = -THREE.MathUtils.degToRad(this.yaw()); }

  // Normalise the car: orient, scale to the standard length, centre, put the tyres on the floor.
  applyModel() {
    const m = this.model;
    const s = this.state;
    if (!m) return;
    this.pivot.position.set(0, 0, 0); // measure in the turntable's own space
    this.pivot.rotation.set(0, 0, 0);
    m.position.set(0, 0, 0);
    m.rotation.set(0, 0, 0);
    m.scale.setScalar(1);
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const measure = () => { this.pivot.updateMatrixWorld(true); box.setFromObject(m); return box.getSize(size); };
    if (s.autoOrient && measure().x > size.z) m.rotation.y = -Math.PI / 2; // scans lie along X, nose on +X: turn it to +Z
    if (s.flip) m.rotation.y += Math.PI; // a scan can't tell its nose from its tail
    measure();
    this.carLike = isCarShape(size); // tall models (humanoids) are never size-locked, see pipeline.js modelScale
    m.scale.setScalar(modelScale(size, s));
    measure();
    const c = box.getCenter(new THREE.Vector3());
    if (s.center) { m.position.x -= c.x; m.position.z -= c.z; }
    if (s.snap) m.position.y -= box.min.y;
    this.pivot.position.set(s.x, s.snap ? 0 : s.y, 0);
    this.applyYaw();
    this.carHeight = size.y;
    this.carSize = size.clone();
    if (s.motion) applyMotion(this, s.motion, this.clipTime ?? null); // motion.js: stance, pose, clip frame
    this.applyMirror();
  }

  // Mirror tool (model-tools.js): keep one half of every mesh, mirror it across the axis through the mesh's
  // centre, seam welded. The original geometry is kept, so turning it off (or another axis) restores it.
  applyMirror() {
    const mi = this.state.mirror;
    const key = mi?.axis ? `${mi.axis}:${mi.keep || 1}` : '';
    if (!this.model || this.mirrorKey === key) return;
    this.mirrorKey = key;
    this.model.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      if (!o.userData.origGeometry) o.userData.origGeometry = o.geometry;
      const orig = o.userData.origGeometry;
      if (o.geometry !== orig) o.geometry.dispose();
      if (!key) { o.geometry = orig; return; }
      const g0 = orig.index ? orig.toNonIndexed() : orig;
      g0.computeBoundingBox();
      const plane = (g0.boundingBox.min[mi.axis] + g0.boundingBox.max[mi.axis]) / 2;
      const attrs = {};
      for (const [n, at] of Object.entries(g0.attributes)) if (!at.isInterleavedBufferAttribute) attrs[n] = { array: at.array, itemSize: at.itemSize };
      const out = mirrorAttributes(attrs, mi.axis, { keep: mi.keep || 1, plane, tol: (g0.boundingBox.max[mi.axis] - g0.boundingBox.min[mi.axis]) * 0.002 });
      const g = new THREE.BufferGeometry();
      for (const [n, a] of Object.entries(out)) g.setAttribute(n, new THREE.BufferAttribute(a.array, a.itemSize));
      if (!out.normal) g.computeVertexNormals();
      o.geometry = g;
    });
    this.ptDirty = true;
  }

  // Click-to-measure: the model surface point under a canvas point (CSS px), in scene space, or null.
  pickPoint(x, y) {
    if (!this.model) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.model, true)[0];
    return hit ? hit.point.toArray() : null;
  }
  // The measure line between two points (null clears it). Compose only; hidden in renders by the caller.
  setMeasure(a, b) {
    if (this.measureLine) { this.scene.remove(this.measureLine); this.measureLine.geometry.dispose(); this.measureLine.material.dispose(); this.measureLine = null; }
    if (!a) return;
    const pts = [new THREE.Vector3(...a), new THREE.Vector3(...(b || a))];
    const mat = new THREE.LineBasicMaterial({ color: 0xff7a66, depthTest: false });
    this.measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    this.measureLine.renderOrder = 999;
    this.scene.add(this.measureLine);
  }
  // A scene point in canvas CSS px (for the measure label).
  toScreen(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    return [(v.x + 1) / 2 * this.width, (1 - v.y) / 2 * this.height];
  }

  // Rigging preview: the bone names of the first skinned mesh, and a heat view of one bone's weights.
  bones() {
    let sk = null;
    this.model?.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o; });
    return sk ? sk.skeleton.bones.map((b) => b.name) : [];
  }
  showWeights(boneName) {
    this.model?.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      if (o.userData.weightMat) { o.material.dispose(); o.material = o.userData.weightMat; delete o.userData.weightMat; }
      if (boneName == null) return;
      const bi = o.skeleton.bones.findIndex((b) => b.name === boneName);
      const g = o.geometry;
      const w = boneWeights(g.attributes.skinIndex.array, g.attributes.skinWeight.array, bi);
      const col = new Float32Array(w.length * 3);
      for (let i = 0; i < w.length; i++) col.set(heat(w[i]), i * 3);
      g.setAttribute('weightColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('color', g.attributes.weightColor);
      o.userData.weightMat = o.material;
      o.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    });
  }

  // Animation preview: show the clip at time t (seconds), or null for the still pose.
  setClipTime(t) { this.clipTime = t; this.applyModel(); this.ptDirty = true; }

  // Reference grid (Compose only, never in renders): floor and back grid, scale silhouettes. Returns the model size in m.
  modelSize() {
    if (!this.model) return null;
    this.pivot.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3());
    return { x: size.x, y: size.y, z: size.z };
  }
  setGrid(on, { cell = 1, divisions = 10, refs = [] } = {}) {
    if (this.refGrid) { this.scene.remove(this.refGrid); this.refGrid.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.refGrid = null; }
    if (on) {
      const g = new THREE.Group();
      g.name = 'referenceGrid';
      const size = cell * divisions;
      const floor = new THREE.GridHelper(size, divisions, 0xff7a66, 0x555555);
      floor.position.y = 0.001;
      const back = new THREE.GridHelper(size, divisions, 0xff7a66, 0x555555);
      back.rotation.x = Math.PI / 2;
      back.position.set(0, size / 2, -size / 2);
      g.add(floor, back);
      let x = -size / 2 + 0.6;
      for (const r of refs) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(r.width, r.height, r.depth), new THREE.MeshBasicMaterial({ color: 0x9fd3ff, wireframe: true, transparent: true, opacity: 0.6 }));
        box.position.set(x + r.width / 2, r.height / 2, -size / 4);
        x += r.width + 0.4;
        g.add(box);
      }
      this.refGrid = g;
      this.scene.add(g);
    }
    this.ptDirty = true;
  }

  applyLights() {
    const s = this.state;
    const rig = this.rig.lighting;
    // A photo scene's light is matched to its photo; the rig then moves and tints it from there.
    const plate = usesPhoto(s) ? plateOf(s).light : null;
    const k = !s.matchLighting ? s : plate || MATCHED[needsBackdrop(s.preset) ? 'backdrop' : s.preset] || MATCHED.showroom;
    const sun = plate?.sun || { azimuth: DEFAULT_LIGHTING.azimuth, elevation: DEFAULT_LIGHTING.elevation, kelvin: DEFAULT_LIGHTING.kelvin };
    this.lights.key.intensity = k.key * rig.key;
    this.lights.fill.intensity = k.fill * rig.fill;
    this.lights.rim.intensity = k.rim * rig.rim;
    this.scene.environmentIntensity = (plate?.env ?? 1) * rig.rim; // the rim slider also sets how much the scene shows in the paint
    const kelvin = THREE.MathUtils.clamp(sun.kelvin + rig.kelvin - DEFAULT_LIGHTING.kelvin, 1500, 12000);
    this.lights.key.color.setRGB(...kelvinColor(kelvin), THREE.SRGBColorSpace);
    const az = THREE.MathUtils.degToRad(sun.azimuth + rig.azimuth - DEFAULT_LIGHTING.azimuth); // 0 = from the camera, negative = camera left
    const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(sun.elevation + rig.elevation - DEFAULT_LIGHTING.elevation, 3, 88));
    this.lights.key.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(12);
    this.lights.fill.position.set(-Math.sin(az) * 9, 3, Math.cos(az) * 9); // low, on the other side of the camera
    if (this.floor) this.floor.material.uniforms.strength.value = plate ? plate.reflection * s.reflection / 0.7 : s.reflection * (s.preset === 'showroom' ? 0.55 : 0.75);
    this.shadow.plane.material.opacity = plate ? plate.shadow : this.state.preset === 'ring' ? 0.85 : 0.7;
    if (this.catcher) this.catcher.material.opacity = (plate?.shadow ?? 0.7) * 0.45;
  }

  // Frames the car for the look (4:3 studio or 1:1 transparent) and fits that frame inside the canvas.
  // The camera is placed so the lens changes perspective, not the size of the car in the frame.
  applyCamera() {
    const s = this.state;
    if (this.tracing) this.pt?.cameraMoved();
    if (s.view === 'free') return this.applyFreeCamera();
    if (this.controls) this.controls.enabled = false;
    if (plateOf(s)) return this.applyPlateCamera(plateOf(s).cam);
    const preset = CAMERAS[s.camera] || CAMERAS.front34;
    const aspect = aspectOf(s.preset);
    const hfov = hfovOf(s.lens);
    // Metres visible across the frame at the car: the footprint diagonal over the fill share, so a turning car
    // never leaves the frame and fills the same share of it whatever its proportions.
    const size = this.carSize || new THREE.Vector3(1.9, 1.3, CAR_LENGTH);
    const width = Math.hypot(size.x, size.z) / (aspect > 1 ? FILL.wide : FILL.square);
    let distance = width / 2 / Math.tan(hfov / 2);
    const target = new THREE.Vector3(0, size.y / 2 + (aspect > 1 ? 0.06 * width : 0), 0); // 4:3 looks keep some floor
    const sphere = s.fit === 'all' && this.sphere();
    if (sphere) { distance = Math.max(distance, fitDistance(sphere.radius, hfov, aspect)); target.copy(sphere.center); }
    const el = THREE.MathUtils.degToRad(preset.elevation);
    this.camera.position.set(target.x, target.y + distance * Math.sin(el), target.z + distance * Math.cos(el));
    this.camera.lookAt(target);
    this.target = target;
    const dr = depthRange(distance, sphere ? sphere.radius : Math.hypot(size.x, size.y, size.z) / 2);
    this.fitFrame(Math.tan(hfov / 2) / aspect, aspect, dr.near, Math.max(dr.far, distance * 6));
  }

  // A photo scene: the camera the photo was taken with (pipeline.js plateCamera), fitted inside the canvas like
  // the 4:3 looks. Lens and camera presets don't apply; the photo decides them.
  applyPlateCamera(cal) {
    const aspect = 4 / 3;
    const cam = plateCamera(cal, aspect);
    const target = new THREE.Vector3(...cam.target);
    this.camera.position.set(...cam.position);
    this.camera.lookAt(target);
    this.target = target;
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.vfov) / 2);
    this.fitFrame(tanV, aspect, 0.1, 200);
    if (this.state.fit === 'all' && this.model) {
      // "Frame all": the photo's camera aims at the floor, not the model, so pull back along its own line of
      // sight until every corner of the model projects inside the frame (at most 10× the photo's distance).
      for (let k = 0; k < 40 && !this.framesModel(0.92); k++) this.camera.position.sub(target).multiplyScalar(1.06).add(target);
      this.camera.updateMatrixWorld();
    }
    this.coverBackground();
  }

  // Whether the model's whole bounding box projects inside the look's frame (ndc ±limit).
  framesModel(limit = 1) {
    if (!this.model) return true;
    this.camera.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(this.model);
    const f = this.frameRect;
    const sx = this.width / f.width; // the frame is letterboxed inside the canvas; ndc is canvas-wide
    const sy = this.height / f.height;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(this.camera);
      if (p.z > 1 || Math.abs(p.x * sx) > limit || Math.abs(p.y * sy) > limit) return false;
    }
    return true;
  }

  // Free roam: the orbit camera (state.orbit), through the look's frame so what sits inside the safe area renders.
  applyFreeCamera() {
    const s = this.state;
    const aspect = plateOf(s) ? 4 / 3 : aspectOf(s.preset);
    if (!s.orbit) { // first time: start exactly where the car view camera is
      s.view = 'car';
      this.applyCamera();
      s.view = 'free';
      s.orbit = { position: this.camera.position.toArray(), target: this.target.toArray() };
    }
    const target = new THREE.Vector3(...s.orbit.target);
    this.camera.position.set(...s.orbit.position);
    this.camera.lookAt(target);
    this.target = target;
    if (this.controls) { this.controls.target.copy(target); this.controls.enabled = true; }
    const sp = this.sphere();
    const dr = sp ? depthRange(this.camera.position.distanceTo(sp.center), sp.radius) : { near: 0.05, far: 2000 };
    this.fitFrame(Math.tan(hfovOf(s.lens) / 2) / aspect, aspect, Math.min(dr.near, 0.05), Math.max(dr.far, 400));
    this.coverBackground();
  }

  // The look's frame (its aspect) inside the canvas: fov from the frame's vertical half-angle tangent, letterboxed.
  fitFrame(tanV, aspect, near, far) {
    const view = this.width / this.height;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(view >= aspect ? tanV : (tanV * aspect) / view));
    this.camera.aspect = view;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.frameRect = view >= aspect
      ? { x: (this.width - this.height * aspect) / 2, y: 0, width: this.height * aspect, height: this.height }
      : { x: 0, y: (this.height - this.width / aspect) / 2, width: this.width, height: this.width / aspect };
  }

  // The model's bounding sphere in scene space (rotation-proof, so a turning car stays framed), or null.
  sphere() {
    if (!this.model) return null;
    this.pivot.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.model).getBoundingSphere(new THREE.Sphere());
  }

  // Free roam in the composer: OrbitControls own the camera between pointer events (drag orbits, wheel zooms,
  // right or Shift drag pans). Every move is copied into state.orbit; onChange(orbit, settled) redraws and saves.
  enableOrbit(onChange) {
    const c = this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(c, { enabled: false, minDistance: 0.2, maxDistance: 400, screenSpacePanning: true });
    c.addEventListener('change', () => {
      this.state.orbit = { position: this.camera.position.toArray(), target: c.target.toArray() };
      onChange(this.state.orbit, false);
    });
    c.addEventListener('end', () => onChange(this.state.orbit, true));
    this.applyCamera(); // the constructor's update() aimed the camera at the origin
  }

  // "Frame all": the whole model in view with a little padding. Free roam moves the orbit camera back along its
  // own line of sight; car view keeps the preset's angle and photo camera but pulls back until the model fits.
  // Returns the scene fields that changed, for saving.
  frameAll() {
    const sphere = this.sphere();
    if (!sphere) return null;
    const s = this.state;
    if (s.view === 'free') {
      if (!s.orbit) this.applyFreeCamera();
      s.orbit = frameOrbit({ center: sphere.center.toArray(), radius: sphere.radius }, s.orbit.position, hfovOf(s.lens), plateOf(s) ? 4 / 3 : aspectOf(s.preset));
    } else s.fit = 'all';
    this.applyCamera();
    return s.view === 'free' ? { orbit: s.orbit } : { fit: s.fit };
  }

  resize(width, height, pixelRatio = 1) {
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    const w = Math.round(width * pixelRatio);
    const h = Math.round(height * pixelRatio);
    if (this.floor) {
      this.floor.getRenderTarget().setSize(w, h);
      this.floor.material.uniforms.texel.value.set(1 / w, 1 / h);
    }
    this.applyCamera();
    if (this.post || this.tracing) this.applyEffects();
  }

  clearStage() {
    for (const o of [...this.stage.children]) { this.stage.remove(o); disposeTree(o); }
    this.floor = null;
    this.catcher = null;
    this.scene.background = null;
    this.scene.environment = null;
    this.scene.backgroundRotation.set(0, 0, 0);
    this.backdropTexture?.dispose();
    this.backdropTexture = null;
    this.backdropEnv?.dispose();
    this.backdropEnv = null;
    this.message = '';
  }

  async buildPreset() {
    const build = ++this.builds;
    this.built = true;
    this.clearStage();
    const p = this.state.preset;
    if (usesPhoto(this.state)) await this.buildPlate(p, build);
    else if (p === 'showroom') this.buildShowroom();
    else if (p === 'ring') this.buildRing();
    else if (p === 'cyclorama') this.buildCyclorama();
    else if (needsBackdrop(p)) await this.buildBackdrop(build);
    else this.scene.environment = this.env('room'); // transparent
    this.applyLights();
  }

  // a) Escalade ring studio. Built the same way every time.
  buildRing() {
    const add = (o) => { this.stage.add(o); return o; };
    this.scene.background = new THREE.Color(0x050505);
    this.scene.environment = this.env('ring');
    const w = Math.round(this.width * this.renderer.getPixelRatio());
    const h = Math.round(this.height * this.renderer.getPixelRatio());
    this.floor = add(new Reflector(new THREE.PlaneGeometry(80, 80), { color: 0x060606, textureWidth: w, textureHeight: h, clipBias: 0.003, shader: FloorShader }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.material.uniforms.texel.value.set(1 / w, 1 / h);
    const wall = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 24), new THREE.MeshStandardMaterial({ color: 0x0d0c0b, roughness: 0.92 })));
    wall.position.set(0, 12, -8);
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.024, 12, 320), emissive(RING, 2.6)));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.012;
    const halo = add(new THREE.Mesh(new THREE.RingGeometry(2.7, 3.9, 320, 1), glowMaterial('ring', RING, 0.16, 0.9, 3.3)));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.008;
    for (const x of [-4.6, 4.6]) { // just inside the frame of the fitted camera
      const bar = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.5, 0.12), emissive('#ffffff', 4)));
      bar.position.set(x, 1.75, -3.8);
      const glow = add(new THREE.Mesh(new THREE.PlaneGeometry(1.6, 3.9), glowMaterial('bar', '#ffffff', 0.22, 0.55)));
      glow.position.set(x, 1.75, -3.85);
      const light = add(new THREE.RectAreaLight(0xffffff, 6, 0.3, 3.5));
      light.position.set(x, 1.75, -3.6);
      light.lookAt(0, 1, 0);
    }
    // The soft glow of the overhead softbox along the top of the back wall. The floor mustn't mirror it:
    // seen from below it smears into a white patch in front of the car.
    const softbox = add(new THREE.Mesh(new THREE.PlaneGeometry(12, 3), glowMaterial('panel', '#ffffff', 0.45, 0.55)));
    softbox.position.set(0, 5.6, -7.9);
    const mirror = this.floor.onBeforeRender;
    this.floor.onBeforeRender = (...args) => {
      softbox.visible = false;
      mirror.apply(this.floor, args);
      softbox.visible = true;
    };
    // The overhead panel itself is only seen in the car paint (environment); here it lights the car.
    const overhead = add(new THREE.RectAreaLight(0xffffff, 3.5, 7, 3));
    overhead.position.set(0, 6.3, -0.6);
    overhead.lookAt(0, 0, -0.6);
  }

  // b) Showroom, modeled (the fallback to the photo): matte near-black room, dark glossy floor, a thin warm-gold
  // ring inset in the floor, two tall white LED bars in the back corners, a big ceiling softbox.
  buildShowroom() {
    const add = (o) => { this.stage.add(o); return o; };
    this.scene.background = new THREE.Color(0x09090a);
    this.scene.environment = this.env('showroom');
    const w = Math.round(this.width * this.renderer.getPixelRatio());
    const h = Math.round(this.height * this.renderer.getPixelRatio());
    this.floor = add(new Reflector(new THREE.PlaneGeometry(80, 80), { color: 0x0b0a0a, textureWidth: w, textureHeight: h, clipBias: 0.003, shader: FloorShader }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.material.uniforms.texel.value.set(1 / w, 1 / h);
    this.floor.material.uniforms.blur.value = 3; // dark and glossy, a little soft
    const wall = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 24), new THREE.MeshStandardMaterial({ color: 0x100f0f, roughness: 0.9 })));
    wall.position.set(0, 12, -8);
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.014, 12, 320), emissive(GOLD, 1.5)));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.008;
    const halo = add(new THREE.Mesh(new THREE.RingGeometry(3.0, 3.6, 320, 1), glowMaterial('ring', GOLD, 0.06, 0.25, 3.3)));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.006;
    // Two tall white LED bars in the back corners, as in the reference photo (same camera as the photo).
    for (const x of [-4.8, 4.8]) {
      const bar = add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), emissive('#ffffff', 3.5)));
      bar.position.set(x, 1.3, -4.2);
      const glow = add(new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.9), glowMaterial('bar', '#ffffff', 0.14, 0.35)));
      glow.position.set(x, 1.3, -4.25);
      const light = add(new THREE.RectAreaLight(0xffffff, 4, 0.3, 2.6));
      light.position.set(x, 1.3, -4);
      light.lookAt(0, 0.8, 0);
    }
    // The big ceiling softbox: a lit panel in the ceiling, seen across the top of the frame.
    const softbox = add(new THREE.Mesh(new THREE.PlaneGeometry(9, 5), emissive('#f4f7ff', 1.3)));
    softbox.rotation.x = Math.PI / 2;
    softbox.position.set(0, 6, -5.5);
    const ceiling = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshBasicMaterial({ color: 0x050505 })));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, 6.02, 0);
    const overhead = add(new THREE.RectAreaLight(kelvinHex(6500), 3.2, 8, 5));
    overhead.position.set(0, 4.5, -0.6);
    overhead.lookAt(0, 0, -0.6);
  }

  // Photo scenes: the plate stays fixed behind the car (only the car turns). The car sits on the photo's floor
  // with a shadow catcher, the contact shadow and, on shiny floors, a soft reflection of the car alone.
  async buildPlate(slug, build) {
    const add = (o) => { this.stage.add(o); return o; };
    const { light } = PLATES[slug];
    const showroom = slug === 'showroom';
    this.scene.environment = showroom ? this.env('showroom') : this.env('room');
    // The key light's shadow, caught on an invisible floor.
    this.catcher = add(new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: light.shadow * 0.45, depthWrite: false })));
    this.catcher.receiveShadow = true;
    this.catcher.position.y = 0.002;
    const [sky, ground, ambient] = light.sky;
    add(new THREE.HemisphereLight(sky, ground, ambient));
    if (light.reflection > 0) {
      const w = Math.round(this.width * this.renderer.getPixelRatio());
      const h = Math.round(this.height * this.renderer.getPixelRatio());
      this.floor = add(new Reflector(new THREE.PlaneGeometry(40, 40), { textureWidth: w, textureHeight: h, clipBias: 0.003, shader: GlossShader }));
      this.floor.rotation.x = -Math.PI / 2;
      this.floor.position.y = 0.001;
      this.floor.material.transparent = true;
      this.floor.material.depthWrite = false;
      this.floor.material.uniforms.texel.value.set(1 / w, 1 / h);
      this.floor.material.uniforms.blur.value = showroom ? 2.5 : 1.5;
      const mirror = this.floor.onBeforeRender;
      this.floor.onBeforeRender = (...args) => { // mirror the car only, never the photo
        const bg = this.scene.background;
        const shadow = this.shadow.plane.visible;
        this.scene.background = null;
        this.shadow.plane.visible = false;
        mirror.apply(this.floor, args);
        this.scene.background = bg;
        this.shadow.plane.visible = shadow;
      };
    }
    if (showroom) {
      // Matched to the reference: cool overhead softbox, white bars in the back corners, the gold ring's glow
      // from underneath, little ambient.
      const overhead = add(new THREE.RectAreaLight(kelvinHex(6500), 3.2, 8, 5));
      overhead.position.set(0, 6.3, -0.6);
      overhead.lookAt(0, 0, -0.6);
      for (const x of [-4.8, 4.8]) {
        const bar = add(new THREE.RectAreaLight(0xffffff, 5, 0.3, 3));
        bar.position.set(x, 1.5, -4.2);
        bar.lookAt(0, 0.8, 0);
      }
      const glow = add(new THREE.RectAreaLight(light.glow[0], light.glow[1], 6.6, 6.6));
      glow.position.set(0, 0.01, 0);
      glow.lookAt(0, 1, 0);
    }
    let tex;
    try {
      tex = await new THREE.TextureLoader().loadAsync(plateUrl(slug));
    } catch {
      if (build !== this.builds) return;
      // No plate on disk: keep the lights and camera so a render still works, on a plain dark background.
      this.scene.background = new THREE.Color(slug === 'white-cyc-studio' ? 0xeceef1 : 0x0b0a09);
      this.message = `Backplate ${slug}.jpg is missing · showing a plain background`;
      return;
    }
    if (build !== this.builds) { tex.dispose(); return; }
    tex.colorSpace = THREE.SRGBColorSpace;
    this.backdropTexture = tex;
    this.scene.background = tex;
    if (!showroom && slug !== 'white-cyc-studio') {
      // Reflections that match the photo: the plate itself, wrapped round as a rough environment.
      const envTex = tex.clone();
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      envTex.needsUpdate = true;
      this.backdropEnv = this.pmrem.fromEquirectangular(envTex);
      envTex.dispose();
      this.scene.environment = this.backdropEnv.texture;
    }
    this.coverBackground();
  }

  // c) White cyclorama: floor curving up into the back wall, soft top light.
  buildCyclorama() {
    const add = (o) => { this.stage.add(o); return o; };
    this.scene.background = new THREE.Color(0xeceef1);
    this.scene.environment = this.env('room');
    const r = 4;
    const profile = []; // (z, y): flat floor, a quarter-circle cove, then the wall
    for (let i = 0; i <= 8; i++) profile.push([30 - i * (30 / 8), 0]);
    for (let i = 1; i <= 16; i++) { const a = (i / 16) * (Math.PI / 2); profile.push([-r * Math.sin(a), r - r * Math.cos(a)]); }
    for (let i = 1; i <= 6; i++) profile.push([-r, r + i * 3]);
    const geo = new THREE.PlaneGeometry(60, 1, 1, profile.length - 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const [z, y] = profile[Math.floor(i / 2)];
      pos.setXYZ(i, i % 2 ? 30 : -30, y, z);
    }
    geo.computeVertexNormals();
    const cyc = add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.92, side: THREE.DoubleSide })));
    cyc.receiveShadow = true;
    cyc.position.z = -3.5;
    const top = add(new THREE.RectAreaLight(0xffffff, 4, 8, 4));
    top.position.set(0, 7, 0);
    top.lookAt(0, 0, 0);
    add(new THREE.HemisphereLight(0xffffff, 0xd8dadd, 0.7));
  }

  // d/e) Your HDRI (environment + ground-projected background) or your backdrop image.
  async buildBackdrop(build) {
    const file = this.state.backdrop;
    if (!file) {
      this.scene.background = new THREE.Color(0x0b0a09);
      this.scene.environment = this.env('room');
      this.message = this.state.preset === 'miami' ? 'Add your Miami HDRI' : 'Upload a backdrop image or HDRI';
      return;
    }
    const url = `/backdrops/${encodeURIComponent(file)}`;
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    let tex;
    try {
      tex = ext === '.hdr' ? await new HDRLoader().loadAsync(url) : ext === '.exr' ? await new EXRLoader().loadAsync(url) : await new THREE.TextureLoader().loadAsync(url);
    } catch {
      if (build !== this.builds) return;
      this.scene.environment = this.env('room');
      this.message = 'Could not load that backdrop';
      return;
    }
    if (build !== this.builds) { tex.dispose(); return; } // another preset was picked while this one loaded
    this.backdropTexture = tex;
    const image = tex.image;
    const equirect = ext === '.hdr' || ext === '.exr' || Math.abs(image.width / image.height - 2) < 0.05;
    if (equirect) {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      if (ext !== '.hdr' && ext !== '.exr') tex.colorSpace = THREE.SRGBColorSpace;
      this.backdropEnv = this.pmrem.fromEquirectangular(tex);
      this.scene.environment = this.backdropEnv.texture;
      const sky = new GroundedSkybox(tex, 3, 90);
      sky.position.y = 3 - 0.01;
      this.stage.add(sky);
    } else {
      // A flat photo: fills the frame behind the car like a backdrop print.
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
      this.scene.environment = this.env('room');
      this.coverBackground();
    }
  }

  // Fits a flat background photo to the frame like a print (cover), and lines it up with the frame inside the
  // canvas: in the composer the canvas is wider or taller than the frame, and a plate must stay matched to the
  // camera. Outside the frame the photo's edges are stretched.
  coverBackground() {
    const tex = this.scene.background;
    if (!tex?.isTexture || !tex.image) return;
    const { x, y, width: fw, height: fh } = this.frameRect;
    const frame = fw / fh;
    const img = tex.image.width / tex.image.height;
    const rx = img > frame ? frame / img : 1;
    const ry = img > frame ? 1 : img / frame;
    tex.repeat.set((rx * this.width) / fw, (ry * this.height) / fh);
    tex.offset.set((1 - rx) / 2 - (rx * x) / fw, (1 - ry) / 2 - (ry * (this.height - y - fh)) / fh);
  }

  setDisplay({ wireframe = false, textures = true } = {}) {
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        m.wireframe = wireframe;
        m.map = textures ? m.userData.map : null;
        m.needsUpdate = true;
      }
    });
  }

  render() {
    if (this.model) this.shadow.update(this.renderer, this.scene, this.state.shadow);
    this.shadow.plane.visible = Boolean(this.model);
    if (this.tracing && this.pt?.tracer && !this.ptDirty && !this.ptBusy) { if (this.pt.renderSample() || this.pt.done) return; }
    if (this.post?.composer) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls?.dispose();
    this.post?.dispose();
    this.pt?.dispose();
    for (const h of Object.values(this.hdris)) { h.tex.dispose(); h.env.dispose(); }
    for (const m of this.pieceMats.values()) m.dispose();
    this.clearStage();
    if (this.model) disposeTree(this.model);
    for (const t of Object.values(this.envs)) t.dispose();
    this.shadow.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
