// Test Rig controls, as pure rules the tests drive: the keycap strip (which caps light up), where a key goes (the
// game, the Look panel, or nowhere), the first-time How to play card, and the short hint for what you can do here.
import { ARENA, TUNE, groundAt } from './testrig.js';

// The bottom-left strip: one group per action, each cap lit while one of its codes is held. 'Mouse' is held while
// the mouse turns the camera. Climbing is a jump at a ledge, so its key is Space.
export const KEYCAPS = [
  { label: 'Move', caps: [['W', 'KeyW'], ['A', 'KeyA'], ['S', 'KeyS'], ['D', 'KeyD']] },
  { label: 'Run', caps: [['Shift', 'ShiftLeft', 'ShiftRight']] },
  { label: 'Jump', caps: [['Space', 'Space']] },
  { label: 'Climb', caps: [['Space', 'Space']], tip: 'Jump at a ledge to climb up it' },
  { label: 'Look', caps: [['Mouse', 'Mouse']], tip: 'Click the scene, then move the mouse' },
  { label: 'Leave', caps: [['Esc', 'Escape']], tip: 'Esc frees the mouse, press it again to leave' },
];
/** Whether a cap ([label, ...codes]) is lit for the held codes (a Set). */
export const capLit = (cap, held) => cap.slice(1).some((c) => held.has(c));

/**
 * Where a key press goes. 'game': the character (and nothing else in the app). 'close': Esc while the Look panel is
 * open shuts it. 'panel': the panel's own controls get it; the game ignores it. 'pass': F keys stay with the app.
 */
export function keyRoute(key, { panelOpen = false } = {}) {
  if (/^F\d+$/.test(key)) return 'pass';
  if (panelOpen) return key === 'Escape' ? 'close' : 'panel';
  return 'game';
}

// The How to play card shows the first time, then only when asked for (? key). storage: localStorage or a stand-in.
const SEEN = 'flatform.testrig.howto';
export const showHowTo = (storage) => { try { return storage?.getItem(SEEN) !== '1'; } catch { return true; } };
export const rememberHowTo = (storage) => { try { storage?.setItem(SEEN, '1'); } catch { /* private mode: it shows again next time */ } };

// How high a jump and a jump in the air lift the feet (m).
const JUMP = TUNE.jump ** 2 / (2 * TUNE.gravity), DOUBLE = TUNE.doubleJump ** 2 / (2 * TUNE.gravity);
/** The short hint for where the player is: a climbable block right ahead, a wall run, or nothing (''). */
export function contextPrompt(p, world = ARENA, T = TUNE) {
  if (p.mode === 'wallrun') return 'Space to jump off the wall';
  if (p.mode === 'climb' || p.mode === 'roll') return '';
  const ahead = T.radius + 0.6;
  const top = groundAt(world, p.pos[0] + Math.sin(p.yaw) * ahead, p.pos[2] + Math.cos(p.yaw) * ahead);
  const rise = top - p.pos[1];
  if (rise <= T.step) return '';
  if (!p.grounded) return rise <= T.reach ? 'Keep pushing forward to grab the edge' : '';
  const spare = 0.3; // a jump only just gets there: say to jump twice
  if (rise <= JUMP + T.reach - spare) return 'Space to climb';
  if (rise <= JUMP + DOUBLE + T.reach - spare) return 'Space, then Space again to climb';
  return '';
}
