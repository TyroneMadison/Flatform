// The Three.js studio shared by Review, the scene composer and the in-app renderer.
//
// Conventions (also used by render/blender_turntable.py):
// - Metres, Y up. Every car is normalised on load: length along Z, centred on the origin, tyres on y = 0, and scaled
//   so its length is CAR_LENGTH ("Fit"), so every car in the fleet matches.
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
import { STEP } from './pipeline.js';

RectAreaLightUniformsLib.init();

export const CAR_LENGTH = 4.6;
export const RING = '#ff7a66'; // the accent colour of the app
export const CAMERAS = {
  front34: { label: 'Front ¾', turn: 30, elevation: 13, lens: 50, height: 'eye height' },
  side: { label: 'Side', turn: 90, elevation: 6, lens: 50, height: 'eye height' },
  rear34: { label: 'Rear ¾', turn: 150, elevation: 13, lens: 50, height: 'eye height' },
  low: { label: 'Low hero', turn: 30, elevation: 2.5, lens: 35, height: 'low' },
};
// 'ring' was called 'gold' before v0.4; the server renames it in saved scenes and settings.
export const PRESETS = {
  ring: { label: 'Escalade ring studio', note: 'Reflective floor · coral ring · side light bars' },
  transparent: { label: 'Transparent', note: 'RGBA PNG with soft contact shadow' },
  cyclorama: { label: 'White cyclorama', note: 'Seamless white, soft top light' },
  miami: { label: 'Miami street at night', note: 'Add your Miami HDRI' },
  custom: { label: 'Your backdrop or HDRI', note: 'Upload a JPG, PNG, EXR or HDR' },
};
// Light intensities each preset uses when "Match lighting to scene" is on.
const MATCHED = {
  ring: { key: 1.3, fill: 0.3, rim: 1.4 },
  transparent: { key: 1.6, fill: 0.6, rim: 0.9 },
  cyclorama: { key: 1.1, fill: 0.6, rim: 0.4 },
  backdrop: { key: 0.5, fill: 0.15, rim: 0.4 },
};

export function defaultScene(settings = {}) {
  return {
    preset: settings.defaultScene && settings.defaultScene !== 'transparent' ? settings.defaultScene : 'ring',
    backdrop: null, x: 0, y: 0, snap: true, turn: 30, scale: 1, sameSize: true,
    camera: 'front34', lens: 50, matchLighting: true, key: 1.3, fill: 0.3, rim: 1.4,
    reflection: 0.7, shadow: 0.5, autoOrient: true, center: true, flip: false,
  };
}
export const lookOf = (preset) => (preset === 'transparent' ? 'transparent' : 'studio');
export const aspectOf = (preset) => (preset === 'transparent' ? 1 : 4 / 3);
const needsBackdrop = (preset) => preset === 'miami' || preset === 'custom';

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

// Contact shadow: renders the car from below into a small target, blurs it and lays it on the floor
// (after the three.js "shadow contact" example). Updated every frame because the car turns.
class ContactShadow {
  constructor(size = 9, res = 512, height = 2.4) {
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
    this.scene.add(...Object.values(this.lights));
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envs = {};
    this.builds = 0; // a newer preset wins over one that is still loading its HDRI
    this.state = defaultScene();
    this.frame = 0;
    this.width = canvas.width;
    this.height = canvas.height;
    this.frameRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }

  env(name) {
    this.envs[name] ||= this.pmrem.fromScene(name === 'ring' ? ringEnvironment() : new RoomEnvironment(), 0.04).texture;
    return this.envs[name];
  }

  async load(url) {
    // Decoders for compressed GLBs ship with three and are served locally.
    const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    draco.dispose();
    if (this.model) { this.pivot.remove(this.model); disposeTree(this.model); }
    this.model = gltf.scene;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.layers.enable(1); // seen by the contact shadow camera
      for (const m of [].concat(o.material)) m.userData.map = m.map; // for "textures off"
    });
    this.pivot.add(this.model);
    this.applyModel();
    return this.model;
  }

  async setState(next) {
    const prev = this.state;
    this.state = { ...prev, ...next };
    if (!this.built || prev.preset !== this.state.preset || prev.backdrop !== this.state.backdrop) await this.buildPreset();
    this.applyModel();
    this.applyLights();
    this.applyCamera();
  }

  setFrame(i) {
    this.frame = i;
    this.applyYaw();
  }

  yaw() { return this.state.turn + this.frame * STEP; }
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
    if (s.autoOrient && measure().x > size.z) m.rotation.y = Math.PI / 2; // scans often lie along X; cars are measured along Z
    if (s.flip) m.rotation.y += Math.PI; // a scan can't tell its nose from its tail
    measure();
    m.scale.setScalar((CAR_LENGTH / Math.max(size.x, size.z, 1e-6)) * (s.sameSize ? 1 : s.scale));
    measure();
    const c = box.getCenter(new THREE.Vector3());
    if (s.center) { m.position.x -= c.x; m.position.z -= c.z; }
    if (s.snap) m.position.y -= box.min.y;
    this.pivot.position.set(s.x, s.snap ? 0 : s.y, 0);
    this.applyYaw();
    this.carHeight = size.y;
  }

  applyLights() {
    const s = this.state;
    const k = s.matchLighting ? MATCHED[needsBackdrop(s.preset) ? 'backdrop' : s.preset] : s;
    this.lights.key.intensity = k.key;
    this.lights.fill.intensity = k.fill;
    this.lights.rim.intensity = k.rim;
    if (this.floor) this.floor.material.uniforms.strength.value = s.reflection * 0.75;
    this.shadow.plane.material.opacity = this.state.preset === 'ring' ? 0.85 : 0.7;
  }

  // Frames the car for the look (4:3 studio or 1:1 transparent) and fits that frame inside the canvas.
  // The camera is placed so the lens changes perspective, not the size of the car in the frame.
  applyCamera() {
    if (this.freeCamera) { // Review: OrbitControls owns the camera
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.frameRect = { x: 0, y: 0, width: this.width, height: this.height };
      return;
    }
    const s = this.state;
    const preset = CAMERAS[s.camera] || CAMERAS.front34;
    const aspect = aspectOf(s.preset);
    const hfov = 2 * Math.atan(17.5 / s.lens); // 35 mm film gauge
    const width = aspect > 1 ? 10.4 : 7.4; // metres visible across the frame at the car
    const distance = width / 2 / Math.tan(hfov / 2);
    const target = new THREE.Vector3(0, aspect > 1 ? 1.15 : 0.75, 0);
    const el = THREE.MathUtils.degToRad(preset.elevation);
    this.camera.position.set(0, target.y + distance * Math.sin(el), distance * Math.cos(el));
    this.camera.lookAt(target);
    const view = this.width / this.height;
    const tanV = Math.tan(hfov / 2) / aspect; // vertical half-angle of the look
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(view >= aspect ? tanV : (tanV * aspect) / view));
    this.camera.aspect = view;
    this.camera.near = 0.1;
    this.camera.far = distance * 6;
    this.camera.updateProjectionMatrix();
    this.frameRect = view >= aspect
      ? { x: (this.width - this.height * aspect) / 2, y: 0, width: this.height * aspect, height: this.height }
      : { x: 0, y: (this.height - this.width / aspect) / 2, width: this.width, height: this.width / aspect };
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
  }

  clearStage() {
    for (const o of [...this.stage.children]) { this.stage.remove(o); disposeTree(o); }
    this.floor = null;
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
    if (p === 'ring') this.buildRing();
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
    for (const x of [-5.9, 5.9]) {
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

  coverBackground() {
    const tex = this.scene.background;
    if (!tex?.isTexture || !tex.image) return;
    const frame = this.frameRect.width / this.frameRect.height;
    const img = tex.image.width / tex.image.height;
    tex.repeat.set(img > frame ? frame / img : 1, img > frame ? 1 : img / frame);
    tex.offset.set((1 - tex.repeat.x) / 2, (1 - tex.repeat.y) / 2);
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
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.clearStage();
    if (this.model) disposeTree(this.model);
    for (const t of Object.values(this.envs)) t.dispose();
    this.shadow.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
