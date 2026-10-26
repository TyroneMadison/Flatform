// Spin sets for Dud Rents (server side). Two ways in: a folder of car photos imported on the Spin set screen, or
// "Generate Spin Set", which renders the car's own 3D model with the Max realism profile (realism.mjs) through
// Blender Cycles. Both end in the handoff format (public/lib/handoff.js) inside <outputRoot>/<slug>, and
// "Send to Dud Rents" (handoff.mjs) zips it with a ready.json marker. The page builds the sprite sheets from the
// frames (public/lib/sheets.js) because Node has no image codec; this file writes everything else.
import { writeFile, mkdir, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPIN_OPTIONS, DEFAULT_OPTION } from './public/lib/spinset.js';
import { handoffManifest, spinHandoffText, manifestFile, webDir } from './public/lib/handoff.js';
import { LOOKS, ENVIRONMENTS, envCamera } from './public/lib/pipeline.js';
import { blenderEnvironment } from './public/lib/environments.js';
import { MAX_REALISM, withProfile, blenderProfile, createBasePath } from './realism.mjs';
import { sendToDudRents } from './handoff.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** viewer.html for the Dud Rents layout: one block per look and turn, reading the json next to the sheets. */
export function dudViewerHtml({ name, looks, turns }) {
  const blocks = looks.flatMap((look) => turns.map((turn) => `
<section><h2>${esc(LOOKS[look]?.label || look)} ${turn}</h2>
  <div class="frame" style="max-width:512px"><div data-spin="${manifestFile(look, turn)}" data-size="512" data-autoplay="${turn === 360 ? 12 : 0}"></div></div>
</section>`)).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)} · spin viewer</title>
<style>body{margin:0;padding:32px;background:#0b0a09;color:#efe7e3;font:15px/1.5 system-ui,sans-serif}h1{margin:0 0 4px}h2{margin:0 0 8px;font-size:16px}section{margin:32px 0}.frame{border:1px solid #2a2220;border-radius:6px;overflow:hidden}</style>
</head><body><h1>${esc(name)}</h1><p>Drag, swipe or use the arrow keys to turn the car.</p>${blocks}<script src="spin-viewer.js"></script></body></html>
`;
}

/**
 * ctx: { modelsDir, settings (live), version, blenderScript, findBlender(), runBlender(job, bin, args), basePath? }
 */
export function createSpinService(ctx) {
  const jobs = new Map(); // model id → the running or last Generate Spin Set job
  const basePath = ctx.basePath || createBasePath();
  const view = (job) => job && { status: job.status, frame: job.frame, frames: job.frames, look: job.look, option: job.option, interior: job.interior, applied: job.applied, error: job.error, ran: job.ran };

  /** Writes the manifests, HANDOFF.md, viewer and spin-viewer.js for frames the page already put in place. */
  async function writeMeta(m, outDir, { look = 'showroom', option = DEFAULT_OPTION, source = 'spin set', renderer = 'Flatform' }) {
    const o = SPIN_OPTIONS[option];
    if (!o) throw new Error('Unknown spin option');
    const turns = o.turn === 360 ? [360, 180] : [180];
    const renderDate = new Date().toISOString().slice(0, 10);
    const manifests = {};
    for (const turn of turns) {
      const frames = turn === 180 ? Math.min(o.frames, SPIN_OPTIONS[180].frames) : o.frames;
      manifests[turn] = handoffManifest({ slug: m.slug, name: m.name, look, turn, frames, step: o.step, renderDate, sourceModel: m.glb ? `${m.slug}.glb` : source });
      await mkdir(path.join(outDir, webDir(look)), { recursive: true });
      await writeFile(path.join(outDir, manifestFile(look, turn)), JSON.stringify(manifests[turn], null, 2));
    }
    await copyFile(path.join(ROOT, 'public', 'lib', 'dud-viewer.js'), path.join(outDir, 'spin-viewer.js'));
    await writeFile(path.join(outDir, 'viewer.html'), dudViewerHtml({ name: m.name, looks: [look], turns }));
    await writeFile(path.join(outDir, 'HANDOFF.md'), spinHandoffText({ slug: m.slug, name: m.name, looks: [look], turns, frames: o.frames, step: o.step, renderer, renderDate, source }));
    m.spin = { ...(m.spin || {}), outDir, look, option, turns, frames: o.frames, at: new Date().toISOString() };
    return { manifests, turns };
  }

  /**
   * Generate Spin Set: one click. Applies the Max realism profile for the run only, auto-orbits at the scene's fixed
   * height and distance, renders every frame at final quality through Blender, then restores the user's settings.
   * option: 72 (default), 36 or 180. interior: also render an interior spin into frames/interior.
   */
  function start(m, outDir, { option = DEFAULT_OPTION, interior = false } = {}) {
    const o = SPIN_OPTIONS[option];
    if (!o) throw Object.assign(new Error(`Render ${Object.keys(SPIN_OPTIONS).join(', ')} frames`), { status: 400 });
    if (!m.glb) throw Object.assign(new Error('This car has no 3D model to render. Import photos instead.'), { status: 409 });
    const bin = ctx.findBlender();
    if (!bin) throw Object.assign(new Error('Blender not found. Install Blender 4.x or locate it in Settings.'), { status: 409 });
    if (jobs.get(m.id)?.status === 'running') throw Object.assign(new Error('A spin set is already rendering for this car'), { status: 409 });
    const job = { status: 'running', frame: 0, frames: o.frames, look: 'showroom', option, interior, applied: null, error: null, ran: [] };
    jobs.set(m.id, job);
    const sceneFile = path.join(ctx.modelsDir, m.id, 'scene.json');
    (async () => {
      job.ran = await basePath.prepare(m, MAX_REALISM); // material inference and the local detail steps
      await withProfile(ctx.settings, MAX_REALISM, async (effective, applied) => {
        job.applied = applied;
        const looks = [['showroom', 'frames/showroom', []], ...(interior ? [['interior', 'frames/interior', ['--interior']]] : [])];
        for (const [look, sub, extra] of looks) {
          job.look = look;
          job.frame = 0;
          const { width, height } = LOOKS.showroom;
          await ctx.runBlender(job, bin, [
            '-b', '-P', ctx.blenderScript, '--',
            '--glb', path.join(ctx.modelsDir, m.id, m.glb), '--out', path.join(outDir, sub), '--slug', m.slug,
            '--look', 'showroom', '--frames', String(o.frames), '--step', String(o.step), '--res', `${width}x${height}`,
            ...(existsSync(sceneFile) ? ['--scene', sceneFile] : []),
            '--rig', JSON.stringify({ lighting: effective.lighting, glass: effective.glass }),
            '--environment', JSON.stringify(blenderEnvironment('showroom', envCamera(ENVIRONMENTS.showroom.cam, width / height))),
            '--samples', String(MAX_REALISM.samples), '--profile', JSON.stringify(blenderProfile(MAX_REALISM)), ...extra,
          ]);
        }
      });
      job.status = 'done';
    })().catch((e) => {
      if (job.status === 'running') job.status = 'failed';
      job.error = e.message;
    });
    return view(job);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (job?.status === 'running') { job.status = 'cancelled'; job.child?.kill(); }
    return view(job) ?? null;
  }

  async function send(m, outDir, meta = {}) {
    const marker = await sendToDudRents({ carDir: outDir, slug: m.slug, name: m.name, meta: { ...(m.car || {}), ...meta }, version: ctx.version });
    m.spin = { ...(m.spin || {}), sentAt: marker.readyAt, zip: marker.zip };
    return marker;
  }

  return { start, cancel, send, writeMeta, job: (id) => view(jobs.get(id)) ?? null, jobs, basePath, readMarker: (outDir) => readFile(path.join(outDir, 'ready.json'), 'utf8').then(JSON.parse) };
}
