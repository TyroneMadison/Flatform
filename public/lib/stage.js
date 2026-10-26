// The v3 "Stage" layout in plain data: the 4-step trail at the bottom, which screens open as sheets over the stage,
// and the tool dock on the left for each step. Pure (no DOM), so node tests can check it; app.js and the views draw it.

// The step trail: Photo > 3D model > Scene and render > Finish. Rendering lives inside Scene (there is no Render step).
export const STEPS = [
  { id: 'photo', label: 'Photo', tip: 'Start here: drop or choose a photo' },
  { id: 'model', label: '3D model', tip: 'Pick a recipe and make the 3D model' },
  { id: 'scene', label: 'Scene and render', tip: 'Pick a world, colours and lights, then make pictures and spin videos' },
  { id: 'finish', label: 'Finish', tip: 'Check the model, compare and share' },
];
const STEP_OF = { drop: 'photo', warframe: 'photo', setup: 'model', generate: 'model', compose: 'scene', spin: 'scene', finish: 'finish' };
/** The step a screen belongs to, or null for sheets and full-screen modes. */
export const stepOf = (screen) => STEP_OF[screen] || null;

// Screens that open as a sheet over the stage (Esc or ✕ closes them and goes back to the step you were on).
export const SHEETS = { library: 'Library', model: 'Library', settings: 'Settings', share: 'Share links', usage: 'Usage' };
export const isSheet = (screen) => screen in SHEETS;

/** The trail for a screen. hrefs: { photo, model, scene, finish } links (app.js works them out from the library). */
export function journey(screen, hrefs = {}) {
  const at = STEPS.findIndex((s) => s.id === stepOf(screen));
  return STEPS.map((s, i) => ({ ...s, n: i + 1, href: hrefs[s.id] || '#/drop', state: i === at ? 'current' : at >= 0 && i < at ? 'done' : 'todo' }));
}

// The dock for each step: [id, icon, label, tooltip]. Icons are names from lib/icons.js.
const SCENE_TOOLS = (humanoid) => [
  ['world', 'scene', 'World', 'The room around your model: 3D worlds, ground, placement and grid'],
  ['look', 'paint', 'Look', 'Colours, materials, decals and saved looks. Tip: click a part in the 3D view'],
  ['light', 'light', 'Light', 'Light presets, brightness and the sky light'],
  ['camera', 'camera', 'Camera', 'Camera spots, lens, camera moves and the turntable'],
  humanoid ? ['pose', 'person', 'Pose', 'Pose by hand, stance, animation and the Test Rig']
    : ['carparts', 'car', 'Car parts', 'Doors, hood, trunk, wheels and ride height'],
  ['tools', 'tools', 'Tools', 'Measure, line up, mirror, Reset scene, Restore last session and versions'],
  ['render', 'film', 'Render', 'Make pictures, spin videos and more. The only place renders start'],
];
export function dockFor(step, { humanoid = false } = {}) {
  if (step === 'scene') return SCENE_TOOLS(humanoid);
  if (step === 'model') return [['recipe', 'settings', 'Recipe', 'Preset, engine and fine-tune, with the cost'], ['photos', 'image', 'Photos', 'One photo, or front, side and back']];
  if (step === 'finish') return [['check', 'check', 'Check', 'Check before export and fix what it finds'], ['compare', 'eye', 'Compare', 'Before and after'], ['share', 'external', 'Share', 'Send a link or show a client']];
  return [];
}
export const DEFAULT_TOOL = { scene: 'world', model: 'recipe', finish: 'check' };

// Which parts of the Scene screen each dock tool shows (element ids in views/compose.js and its modules).
export const SCENE_GROUPS = {
  world: ['scenes', 'grp-place', 'grp-model', 'grp-ground', 'grp-grid'],
  look: ['grp-templates', 'grp-parts', 'grp-color', 'grp-material', 'grp-decals'],
  light: ['grp-lighting', 'grp-light', 'grp-scene'],
  camera: ['grp-camera', 'grp-path', 'turntable'],
  pose: ['grp-testrig', 'grp-handpose', 'grp-motion'],
  carparts: ['grp-motion'],
  tools: ['startover', 'grp-tools', 'modelGroup', 'grp-export'],
  render: ['renderIdeas', 'renderArea'],
};
// The one-line "what to do here" under each tool's title.
export const TOOL_TIPS = {
  world: 'Click a world. Your model moves into it. Every world is a real 3D room that turns with the camera.',
  look: 'Click a part in the 3D view to change just that part, or infer the colours from your photo.',
  light: 'Click a light card. Brightness and the sky light are below it.',
  camera: 'Click a camera spot, or drag in the 3D view. Lens is in mm: low is wide, high is zoomed in.',
  pose: 'Press Test Rig to play as this character, or pick a pose.',
  carparts: 'Open doors, the hood or the trunk, turn the wheels or change the ride height.',
  tools: 'Reset scene puts everything back to how a new scene starts. You can undo it.',
  render: 'The only place renders start. Pick a type, press Run. Finished files go to the Library.',
};
/** Whether an element id shows for a dock tool. Ids no tool lists always show, so nothing new can go missing. */
export function shows(tool, id) {
  if (!Object.values(SCENE_GROUPS).some((ids) => ids.includes(id))) return true;
  return (SCENE_GROUPS[tool] || SCENE_GROUPS.world).includes(id);
}

// "Changed Background · Undo": the plain name of what an edit changed, from the scene keys it touched.
const CHANGE_NAMES = {
  preset: 'World', backdrop: 'World', look: 'Light and look', paint: 'Colours', motion: 'Pose', pose: 'Pose', handPose: 'Pose',
  camera: 'Camera', lens: 'Lens', view: 'Camera', orbit: 'Camera', fit: 'Camera', bookmarks: 'Camera spots', path: 'Camera move',
  turn: 'Turn', scale: 'Size', x: 'Position', y: 'Position', snap: 'Position', reflection: 'Ground', shadow: 'Ground',
  key: 'Light', fill: 'Light', rim: 'Light', matchLighting: 'Light', mirror: 'Mirror', decals: 'Decals', flip: 'Flip',
  autoOrient: 'Auto-orient', center: 'Center', sameSize: 'Size',
};
export function changeName(keys = []) {
  const names = [...new Set(keys.map((k) => CHANGE_NAMES[k] || 'Scene'))];
  return names.length === 1 ? names[0] : names.length ? `${names[0]} and more` : 'Scene';
}

/** The ring in the render pill: stroke-dasharray for a 0 to 100 percent. */
export const ringDash = (pct) => `${Math.max(0, Math.min(100, Math.round(pct || 0)))} 100`;

/** "About 3 min left" for the 3D model ring: from how long it has run and how far it got. */
export function timeLeft(pct, elapsedMs) {
  if (!(pct >= 5 && pct < 100 && elapsedMs > 0)) return 'A few minutes left';
  const s = (elapsedMs / 1000) * ((100 - pct) / pct);
  return s < 60 ? 'Less than a minute left' : `About ${Math.round(s / 60)} min left`;
}
