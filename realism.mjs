// The "Max realism" render profile Generate Spin Set applies with no manual setup, and the local base path it runs
// on. The profile is used for that one render only: withProfile() snapshots the user's settings, applies the profile
// on top for the run, and puts everything back afterwards, even when the render throws.
//
// The base path is 100% local and free. It never calls Tripo or 3D AI Studio (see test/spin.test.mjs, which stubs
// the network and asserts no paid request). TRELLIS and Detail Boost are built on Sadie's branch; they plug in
// through createBasePath({ trellis, detailBoost }) and are stubbed here so the branches merge cleanly.

export const MAX_REALISM = Object.freeze({
  name: 'Max realism',
  renderer: 'blender', // Cycles final pass
  materialInference: true, // car material inference runs first if the model has none yet
  hdri: 'showroom', // Dud Rents showroom HDRI
  lighting: 'matched', // lighting matched to the showroom plate
  ambientOcclusion: true,
  reflections: 'raytraced',
  refraction: true,
  subsurface: true, // interior leather and fabric
  glass: { on: true, opacity: 0.15, litCabin: true }, // see-through glass with a lit cabin
  denoise: true,
  tonemap: 'AgX', // ACES/AgX view transform
  quality: 'final', // Cycles final samples
  samples: 512,
  bounces: { total: 12, glossy: 8, transmission: 12 },
});
export const PROFILE_KEYS = Object.keys(MAX_REALISM).filter((k) => k !== 'name');

/** What a profile changes in the saved settings for the run: renderer, glass, scene. Pure. */
export function settingsFor(profile = MAX_REALISM) {
  return { renderer: profile.renderer, glass: { ...profile.glass, on: true }, defaultScene: profile.hdri };
}

/** The --profile JSON for render/blender_turntable.py (everything the script switches on). Pure. */
export function blenderProfile(profile = MAX_REALISM) {
  const { name, ...rest } = profile;
  return { ...rest, materialInference: undefined };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Runs `run(effective)` with `profile` laid over `settings` (a live, mutable settings object such as the server's),
 * then restores every key, whatever happens. `effective` is the merged settings the render should use.
 * Returns run's result. Also exposed as the record of what was applied, for the UI and tests.
 */
export async function withProfile(settings, profile, run) {
  const before = clone(settings);
  const patch = settingsFor(profile);
  const applied = { ...patch, profile: clone(profile) };
  try {
    Object.assign(settings, patch);
    return await run({ ...settings, ...patch }, applied);
  } finally {
    for (const k of Object.keys(settings)) if (!(k in before)) delete settings[k];
    Object.assign(settings, clone(before));
  }
}

/**
 * The local base path. prepare(model) runs the free steps in order and reports what ran. Steps Sadie builds
 * (TRELLIS at max settings, Real-ESRGAN upscale, photo-derived normal/displacement maps, Detail Boost) come in
 * through the options; the stubs here report { applied: false, reason } and the pipeline carries on.
 */
export function createBasePath({ trellis, detailBoost, materialInference } = {}) {
  const stub = (name) => async () => ({ step: name, applied: false, reason: 'built on the other branch; stubbed here' });
  const steps = {
    materialInference: materialInference || (async (model) => ({ step: 'materialInference', applied: !model?.materials, reason: model?.materials ? 'already done' : null })),
    trellis: trellis || stub('trellis'),
    detailBoost: detailBoost || stub('detailBoost'),
  };
  return {
    steps,
    paid: false, // never calls a paid provider
    async prepare(model, profile = MAX_REALISM) {
      const ran = [];
      if (profile.materialInference) ran.push(await steps.materialInference(model));
      ran.push(await steps.detailBoost(model));
      return ran;
    },
  };
}
