// Enhance: re-runs a finished Tripo model through Tripo to sharpen it. "texture" redoes the paint in detailed quality,
// "refine" rebuilds the mesh from the draft. The credits here are only the estimate shown before the click; the ledger
// records the real charge from the balance before and after (ledger.mjs actualCredits).
export const ENHANCE = {
  texture: { label: 'Sharper paint', credits: 20, body: (id) => ({ type: 'texture_model', original_model_task_id: id, texture: true, pbr: true, texture_quality: 'detailed' }) },
  refine: { label: 'Cleaner shape', credits: 30, body: (id) => ({ type: 'refine_model', draft_model_task_id: id }) },
};
export const KINDS = Object.keys(ENHANCE);

/** Why this version can't be enhanced, or null when it can. */
export function enhanceBlock(v) {
  if (!v || v.status !== 'ready') return 'Model is not ready yet';
  if (v.provider !== 'tripo') return 'Enhance works on models made with Tripo direct';
  if (!v.task_id) return 'This version has no Tripo task to enhance';
  if (v.enhance?.status === 'running') return 'Already enhancing';
  return null;
}
