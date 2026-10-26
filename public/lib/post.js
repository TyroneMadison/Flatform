// Realtime render upgrades for the studio: an EffectComposer with ambient occlusion (GTAO, SSAO on Medium), bloom
// driven by emissive pieces, screen-space reflections (SSR), SMAA/FXAA, tone mapping and exposure; and a progressive
// path-traced preview (three-gpu-pathtracer, loaded on first use). Everything here is off by default (look.js
// DEFAULT_LOOK), so the plain renderer path of studio.js stays exactly as it was.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

export const TONE = { neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping };

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.key = '';
  }

  // Rebuilds the pass chain when the set of effects changes; otherwise only updates their strengths.
  configure(look, fx, width, height, pixelRatio = 1) {
    const key = JSON.stringify([fx.ao && fx.aoPass, fx.bloom, fx.ssr, fx.aa, width, height, pixelRatio]);
    if (key !== this.key) {
      this.dispose();
      this.key = key;
      const c = this.composer = new EffectComposer(this.renderer);
      c.setPixelRatio(pixelRatio);
      c.setSize(width, height);
      c.addPass(new RenderPass(this.scene, this.camera));
      if (fx.ao) {
        this.ao = fx.aoPass === 'gtao' ? new GTAOPass(this.scene, this.camera, width, height) : new SSAOPass(this.scene, this.camera, width, height);
        c.addPass(this.ao);
      }
      if (fx.ssr) {
        this.ssr = new SSRPass({ renderer: this.renderer, scene: this.scene, camera: this.camera, width, height, selects: null });
        this.ssr.thickness = 0.02;
        this.ssr.maxDistance = 12;
        c.addPass(this.ssr);
      }
      if (fx.bloom) {
        this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.4, 0.9);
        // Cap what feeds the glow: a specular spike on wet asphalt can be 1000x white and would wash the whole frame.
        const hp = this.bloom.materialHighPassFilter;
        hp.fragmentShader = hp.fragmentShader.replace('gl_FragColor = mix( outputColor, texel, alpha );', '$& gl_FragColor = min( gl_FragColor, vec4( 2.0 ) );');
        hp.needsUpdate = true;
        c.addPass(this.bloom);
      }
      c.addPass(new OutputPass()); // tone mapping + sRGB happen here when a composer is in use
      if (fx.aa === 'smaa') { const p = new SMAAPass(); p.setSize(width, height); c.addPass(p); }
      if (fx.aa === 'fxaa') c.addPass(new FXAAPass());
    }
    if (this.ao) {
      if (this.ao.isGTAOPass !== false && this.ao.blendIntensity !== undefined) this.ao.blendIntensity = look.ao.strength;
      else { this.ao.kernelRadius = 6 * look.ao.strength; this.ao.minDistance = 0.001; this.ao.maxDistance = 0.1; }
    }
    if (this.ssr) this.ssr.opacity = look.ssr.strength;
    if (this.bloom) { this.bloom.strength = look.bloom.strength; this.bloom.threshold = look.bloom.threshold; }
  }

  render() { this.composer.render(); }

  dispose() {
    this.composer?.dispose();
    this.composer = this.ao = this.ssr = this.bloom = null;
    this.key = '';
  }
}

// Progressive path tracing (three-gpu-pathtracer). Loaded on first use so the plain app never pays for it.
export class PathTraced {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxSamples = 512;
    this.paused = false;
  }

  async load() {
    if (this.tracer) return this.tracer;
    const { WebGLPathTracer } = await import('three-gpu-pathtracer');
    const t = this.tracer = new WebGLPathTracer(this.renderer);
    t.bounces = 5;
    t.minSamples = 1;
    t.dynamicLowRes = true;
    t.renderScale = 1;
    t.tiles.set(2, 2);
    return t;
  }

  // The scene changed (model, materials, lights, environment): rebuild the BVH and start over. Built on this thread:
  // setSceneAsync needs a BVH worker, and workers do not see the page's import map. ponytail: a big place stalls a
  // frame or so; add three-mesh-bvh's ParallelMeshBVHWorker (bundled) if that shows.
  async setScene(scene, camera) {
    const t = await this.load();
    t.setScene(scene, camera);
    this.paused = false;
  }

  // The camera moved: restart the accumulation (stops on interaction, resumes when the pointer settles).
  cameraMoved() { if (this.tracer) { this.tracer.updateCamera(); this.tracer.reset(); } }
  updateMaterials() { this.tracer?.updateMaterials(); }
  updateEnvironment() { this.tracer?.updateEnvironment(); }

  get samples() { return this.tracer ? Math.floor(this.tracer.samples) : 0; }
  get done() { return this.samples >= this.maxSamples; }

  // One sample; returns true while more samples are wanted.
  renderSample() {
    if (!this.tracer || this.paused || this.done) return false;
    this.tracer.renderSample();
    return !this.done;
  }

  dispose() { this.tracer?.dispose?.(); this.tracer = null; }
}
