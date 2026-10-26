// Render ideas: one-click starting points in the Render tool. Each sets up the scene (world, camera) and ticks what
// to render; nothing starts until you press the orange Render button. Pure data and one function, so node tests can
// check every idea uses a real world, camera and render option. views/compose.js draws the gallery and applies them.

// scene: the scene change (preset is a world key from lib/studio.js PRESETS, camera a key from CAMERAS).
// render: what to tick in the render area (still, t360, t180 and the looks showroom, studio, transparent).
// go: 'finish' opens the Finish step instead of setting up a render. warframe: only shown in Warframe mode.
const SCENE_ONLY = { showroom: false, studio: true, transparent: false };
export const IDEAS = [
  { id: 'hero', label: 'Hero picture', desc: 'Low hero angle, one big picture for a poster or a header',
    art: 'linear-gradient(160deg,#111,#ff7a66)', scene: { camera: 'low' }, render: { still: true, t360: false, t180: false, ...SCENE_ONLY } },
  { id: 'listing', label: 'Listing set', desc: 'Front ¾ picture plus a half turn for the listing page',
    art: 'linear-gradient(90deg,#eee 0 30%,#ccc 30% 33%,#eee 33% 63%,#ccc 63% 66%,#ddd 66%)', scene: { preset: 'cyclorama', camera: 'front34' }, render: { still: true, t360: false, t180: true, ...SCENE_ONLY } },
  { id: 'website', label: 'Website spin', desc: 'A full 360° spin people can drag on your website',
    art: 'radial-gradient(circle at 50% 70%,#ff7a66 0 14%,transparent 15%),linear-gradient(#fafafa,#e6e6e8)', scene: { preset: 'cyclorama', camera: 'front34' }, render: { still: false, t360: true, t180: true, ...SCENE_ONLY } },
  { id: 'cutout', label: 'Cut-out picture', desc: 'No background, just the model and a soft shadow',
    art: 'repeating-conic-gradient(#888 0 25%,#ccc 0 50%) 0/16px 16px', scene: { camera: 'front34' }, render: { still: true, t360: false, t180: false, showroom: false, studio: false, transparent: true } },
  { id: 'neon', label: 'Night neon', desc: 'Wet city street at night, pink and blue lights',
    art: 'linear-gradient(160deg,#28123f,#ff2fa8 60%,#00bcd4)', scene: { preset: 'night-city-rain' }, render: { still: true, t360: false, t180: false, ...SCENE_ONLY } },
  { id: 'golden', label: 'Golden hour', desc: 'Coast road at sunset, warm low sun',
    art: 'linear-gradient(160deg,#f7b267,#e07a5f)', scene: { preset: 'golden-hour-coast' }, render: { still: true, t360: false, t180: false, ...SCENE_ONLY } },
  { id: 'compare', label: 'Photo vs 3D', desc: 'Your photo and the 3D model side by side, in Finish',
    art: 'linear-gradient(90deg,#8a7 0 50%,#ddd 50%)', go: 'finish' },
  { id: 'ingame', label: 'In-game Warframe shot', desc: 'Dark showroom, low hero angle, rim light', warframe: true,
    art: 'linear-gradient(160deg,#0b1a2a,#2a7fbf)', scene: { preset: 'showroom', camera: 'low' }, render: { still: true, t360: false, t180: false, ...SCENE_ONLY } },
];

/** The ideas to show: the Warframe-only ones only in Warframe mode. */
export const ideasFor = (mode = 'car') => IDEAS.filter((i) => !i.warframe || mode === 'warframe');

/** What one idea changes: { scene, render, go }. cameras: CAMERAS from lib/studio.js (turn and lens per spot). */
export function applyIdea(id, cameras = {}) {
  const idea = IDEAS.find((i) => i.id === id);
  if (!idea) return null;
  if (idea.go) return { go: idea.go, label: idea.label };
  const scene = { ...idea.scene };
  const cam = cameras[scene.camera];
  if (cam) Object.assign(scene, { turn: cam.turn, lens: cam.lens, view: 'car', fit: 'footprint' });
  return { scene, render: { ...idea.render }, label: idea.label };
}
