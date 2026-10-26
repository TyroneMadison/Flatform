// A made-up standing person for the auto-rig tests: boxes along each limb (narrower at the knees, elbows, wrists and
// ankles, like a real body), glTF coords (Y up, metres, 1.8 m tall). pieces 'one': one welded piece (thin bridge
// triangles join the boxes). 'armor': that body plus loose, open (non-manifold) armour plates on the thighs, shins,
// forearms, chest and shoulders, like a Tripo multi-piece mesh. arms: 't', 'a', 'down' or 'bent' (one fist raised).
// facing: the way it looks, [x, 0, z]. Returns { positions, tris, truth: { joint: [x, y, z] }, plates: [{ bone, first, count }] }.

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map((v) => v * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));

export function humanoidMesh({ pieces = 'armor', arms = 't', facing = [0, 0, 1] } = {}) {
  const pos = [], tris = [], plates = [];
  // A box round the segment a→b, `half` thick each way, a little longer than the segment so neighbours overlap.
  const box = (a, b, half, { open = false, depth = half } = {}) => {
    const d = norm(sub(b, a));
    const side = norm(Math.abs(d[1]) > 0.9 ? cross(d, [0, 0, 1]) : cross(d, [0, 1, 0]));
    const up = norm(cross(side, d));
    const a2 = sub(a, mul(d, half * 0.3)), b2 = add(b, mul(d, half * 0.3));
    const first = pos.length / 3;
    for (const end of [a2, b2]) for (const [s, u] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pos.push(...add(end, add(mul(side, s * half), mul(up, u * depth))));
    const f = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
    for (const t of open ? f.slice(2) : f) tris.push(...t.map((i) => first + i)); // open: no cap at one end
    return first;
  };
  const truth = {};
  const body = []; // first vertex of each body box, to weld them into one piece
  const part = (a, b, half, opts) => { body.push(box(a, b, half, opts)); };
  // legs
  for (const s of [1, -1]) {
    const x = 0.12 * s;
    Object.assign(truth, { [s > 0 ? 'LeftUpLeg' : 'RightUpLeg']: [x, 0.9, 0], [s > 0 ? 'LeftLeg' : 'RightLeg']: [x, 0.5, 0], [s > 0 ? 'LeftFoot' : 'RightFoot']: [x, 0.09, 0] });
    part([x, 0.92, 0], [x, 0.56, 0], 0.075); // thigh
    part([x, 0.56, 0], [x, 0.45, 0], 0.045); // knee
    part([x, 0.45, 0], [x, 0.14, 0], 0.06); // shin
    part([x, 0.14, 0], [x, 0.06, 0], 0.035); // ankle
    part([x, 0.04, -0.05], [x, 0.04, 0.17], 0.04); // foot, toes forward
  }
  part([-0.17, 0.95, 0], [0.17, 0.95, 0], 0.09, { depth: 0.1 }); // pelvis
  part([0, 0.98, 0], [0, 1.42, 0], 0.17, { depth: 0.11 }); // torso
  part([0, 1.42, 0], [0, 1.56, 0], 0.045); // neck
  part([0, 1.56, 0], [0, 1.8, 0], 0.1); // head
  truth.Hips = [0, 0.97, 0]; truth.Neck = [0, 1.5, 0];
  // arms: shoulder, elbow, wrist, fingertip
  for (const s of [1, -1]) {
    const name = s > 0 ? 'Left' : 'Right';
    const sh = [s * (arms === 'down' ? 0.24 : 0.2), 1.38, 0];
    let dir = [s, 0, 0];
    if (arms === 'a') dir = norm([s, -1, 0]);
    if (arms === 'down') dir = norm([s * 0.12, -1, 0]);
    const el = add(sh, mul(dir, 0.27));
    let fdir = dir;
    if (arms === 'bent' && s > 0) { dir = norm([s * 0.12, -1, 0]); fdir = norm([0.1, 0.75, 0.65]); } // left fist raised in front
    const el2 = arms === 'bent' && s > 0 ? add(sh, mul(dir, 0.27)) : el;
    const wr = add(el2, mul(fdir, 0.25)), tip = add(wr, mul(fdir, 0.17));
    Object.assign(truth, { [`${name}Arm`]: sh, [`${name}ForeArm`]: el2, [`${name}Hand`]: wr, [`${name}HandTip`]: tip });
    part(sh, add(sh, mul(dir, 0.235)), 0.055); // upper arm
    part(add(sh, mul(dir, 0.235)), add(el2, mul(fdir, 0.035)), 0.035); // elbow
    part(add(el2, mul(fdir, 0.035)), add(wr, mul(fdir, -0.025)), 0.045); // forearm
    part(add(wr, mul(fdir, -0.025)), add(wr, mul(fdir, 0.025)), 0.028); // wrist
    part(add(wr, mul(fdir, 0.025)), tip, 0.045, { depth: 0.02 }); // hand
  }
  // One piece: a zero-area triangle from each box to the nearest corner of the box it hangs from (the one before it
  // in its limb; a limb's first box hangs from the pelvis or torso) welds them together.
  const corner = (i) => pos.slice(i * 3, i * 3 + 3);
  const starts = new Set([0, 5, 10, 12, 14, 19]); // thighs, pelvis, neck, upper arms
  body.forEach((f, n) => {
    if (n === 11) return; // the torso
    const targets = starts.has(n) ? [body[10], body[11]].filter((t) => t !== f) : [body[n - 1]];
    let best = -1, bd = Infinity;
    for (const t of targets) for (let i = t; i < t + 8; i++) for (let k = 0; k < 8; k++) { const d = Math.hypot(...sub(corner(i), corner(f + k))); if (d < bd) { bd = d; best = [f + k, i]; } }
    tris.push(best[0], best[1], best[1]);
  });
  if (pieces === 'armor') {
    const plate = (bone, a, b, half, depth = half) => { const first = box(a, b, half, { open: true, depth }); plates.push({ bone, first, count: 8 }); };
    for (const s of [1, -1]) {
      const n = s > 0 ? "Left" : "Right", x = 0.12 * s;
      plate(`${n}UpLeg`, [x, 0.86, 0.01], [x, 0.62, 0.01], 0.088);
      plate(`${n}Leg`, [x, 0.4, 0.015], [x, 0.18, 0.015], 0.072);
      const sh = truth[`${n}Arm`], el = truth[`${n}ForeArm`], wr = truth[`${n}Hand`];
      plate(`${n}ForeArm`, add(el, mul(sub(wr, el), 0.3)), add(el, mul(sub(wr, el), 0.8)), 0.058);
      plate(`${n}Arm`, add(sh, [0, 0.07, 0]), add(sh, [s * 0.12, 0.07, 0]), 0.06, 0.07); // shoulder pad
    }
    plate('Spine1', [0, 1.1, 0.12], [0, 1.36, 0.12], 0.15, 0.025); // chest plate
  }
  // Turn the whole body to face `facing` (it was built facing +Z).
  const f = norm(facing), l = norm(cross([0, 1, 0], f));
  const turn = (p) => [p[0] * l[0] + p[2] * f[0], p[1], p[0] * l[2] + p[2] * f[2]];
  const positions = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) positions.set(turn(pos.slice(i, i + 3)), i);
  return { positions, tris: new Uint32Array(tris), truth: Object.fromEntries(Object.entries(truth).map(([k, p]) => [k, turn(p)])), plates };
}
