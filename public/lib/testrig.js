// Test Rig: a small arena of plain blocks and the movement that runs in it, as pure data and maths (no three.js) so
// the tests drive it frame by frame. Metres and seconds, y up. An original take on fast third-person movement:
// sprint, double jump, crouch and slide, bullet jump, wall run, aim glide, roll and ledge climb, plus the
// animation state machine and the procedural poses (angles per limb) that the rig applier turns into bone rotations.

// Every number the movement uses, in one place to tune.
export const TUNE = {
  gravity: 22, maxFall: 40, radius: 0.35, height: 1.8, step: 0.45, turnRate: 12,
  run: 5, sprint: 8.5, crouchSpeed: 2.2, accel: 45, airAccel: 12,
  jump: 7.6, doubleJump: 7,
  slideMin: 6, slideFriction: 4, slideStop: 2.5,
  bullet: 14, bulletMinPitch: 0.3,
  wallrunMin: 4, wallrunTime: 1.2, wallGravity: 5, wallUp: 3, wallKick: 6, wallLock: 0.4,
  glideFall: 1.8, glideTime: 2, glideDrag: 0.4,
  rollTime: 0.5, rollSpeed: 8, hardLanding: 13,
  climbTime: 0.5, reach: 2.2,
};

// Solids stand on the floor (y = 0 everywhere else): boxes { min: [x,y,z], max: [x,y,z] }. A ramp adds
// rise: 'x+' | 'x-' | 'z+' | 'z-', the way it climbs from min.y to max.y. No ceilings, nothing floats.
const box = (x0, z0, x1, z1, h, rise) => ({ min: [x0, 0, z0], max: [x1, h, z1], ...(rise && { rise }) });
export const ARENA = [
  box(-16, -16, 16, -15, 12), box(-16, 15, 16, 16, 12), box(-16, -15, -15, 15, 12), box(15, -15, 16, 15, 12), // outer walls
  box(3, 3, 4.5, 4.5, 1), // hop on
  box(5, -3, 8, -1, 1.6), // climb up
  box(-4, 4, 0, 10, 1.5, 'z+'), box(-4, 10, 0, 14, 1.5), // ramp to a deck
  box(8, 4, 8.6, 14, 4), // long wall to run along
  box(-12, -4, -8, 0, 2.8), // tall ledge: jump and climb
  box(-12, -12, -6, -8, 3.5), // high deck: double jump, then climb
  box(-7, -8, -6, -4, 3.5, 'z-'), // narrow ramp down from the high deck
  box(10, -12, 13, -9, 2), box(11, -9, 13, -5, 2, 'z-'), // and a ramp down
];
export const START = [0, 0, -6];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Height of a solid's top at (x, z), clamped into its footprint. */
export function topAt(s, x, z) {
  if (!s.rise) return s.max[1];
  const ax = s.rise[0] === 'x' ? 0 : 2;
  const v = ax === 0 ? x : z;
  let f = clamp((v - s.min[ax]) / (s.max[ax] - s.min[ax]), 0, 1);
  if (s.rise[1] === '-') f = 1 - f;
  return s.min[1] + (s.max[1] - s.min[1]) * f;
}
const inside = (s, x, z, pad = 0) => x >= s.min[0] - pad && x <= s.max[0] + pad && z >= s.min[2] - pad && z <= s.max[2] + pad;
/** The highest surface under (x, z) no higher than maxY (the floor is 0). pad lets the feet hang over an edge a bit. */
export function groundAt(world, x, z, maxY = Infinity, pad = 0) {
  let g = 0;
  for (const s of world) {
    if (!inside(s, x, z, pad)) continue;
    const t = topAt(s, clamp(x, s.min[0], s.max[0]), clamp(z, s.min[2], s.max[2]));
    if (t <= maxY && t > g) g = t;
  }
  return g;
}

/**
 * Push a circle (the body, seen from above) out of every solid too tall to step onto. Mutates p ([x, y, z]).
 * Returns the last wall touched as { n: [nx, nz] (pointing away from the wall), top } or null.
 */
export function pushOut(world, p, feetY, T = TUNE) {
  let wall = null;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of world) {
      const cx = clamp(p[0], s.min[0], s.max[0]), cz = clamp(p[2], s.min[2], s.max[2]);
      const top = topAt(s, cx, cz);
      if (top <= feetY + T.step) continue;
      const dx = p[0] - cx, dz = p[2] - cz, d = Math.hypot(dx, dz);
      if (d >= T.radius) continue;
      let n;
      if (d > 1e-9) n = [dx / d, dz / d];
      else { // centre inside the footprint: out through the nearest side
        const sides = [[p[0] - s.min[0], [-1, 0]], [s.max[0] - p[0], [1, 0]], [p[2] - s.min[2], [0, -1]], [s.max[2] - p[2], [0, 1]]];
        n = sides.sort((a, b) => a[0] - b[0])[0][1];
      }
      const ex = n[0] ? (n[0] < 0 ? s.min[0] : s.max[0]) : cx, ez = n[1] ? (n[1] < 0 ? s.min[2] : s.max[2]) : cz;
      p[0] = (d > 1e-9 ? cx : ex) + n[0] * T.radius;
      p[2] = (d > 1e-9 ? cz : ez) + n[1] * T.radius;
      wall = { n, top };
    }
  }
  return wall;
}

/** A ledge the hands can reach in direction dir ([x, z], unit) from feet at pos: { top, to } or null. */
export function findLedge(world, pos, dir, T = TUNE) {
  const ahead = T.radius + 0.4;
  const x = pos[0] + dir[0] * ahead, z = pos[2] + dir[1] * ahead;
  const top = groundAt(world, x, z);
  const rise = top - pos[1];
  if (rise <= T.step || rise > T.reach) return null;
  return { top, to: [x, top, z] };
}

/** Which way a model faces (yaw, 0 = +z) from its left side and up directions ([x, y, z]): forward = left × up. */
export function facingYaw(left, up) {
  const fx = left[1] * up[2] - left[2] * up[1], fz = left[0] * up[1] - left[1] * up[0];
  return Math.atan2(fx, fz);
}

export function newPlayer(at = START) {
  return {
    pos: [...at], vel: [0, 0, 0], yaw: 0, mode: 'ground', grounded: true, crouch: false, sprint: false,
    jumpsLeft: 1, jumpKind: null, glideLeft: TUNE.glideTime, gliding: false, timer: 0, wall: null, wallLock: 0, climb: null, held: {},
  };
}

const hspeed = (v) => Math.hypot(v[0], v[2]);
function steerTo(v, tx, tz, maxDelta) { // move v's horizontal part towards (tx, tz) by at most maxDelta
  const dx = tx - v[0], dz = tz - v[2], d = Math.hypot(dx, dz);
  const f = d > maxDelta ? maxDelta / d : 1;
  v[0] += dx * f; v[2] += dz * f;
}
function turnTo(a, b, maxStep) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + clamp(d, -maxStep, maxStep);
}
function land(s, impact, T) {
  s.grounded = true; s.vel[1] = 0; s.jumpsLeft = 1; s.glideLeft = T.glideTime; s.gliding = false; s.jumpKind = null; s.wall = null;
  const hs = hspeed(s.vel);
  if (impact < -T.hardLanding && hs > 1) startRoll(s, s.vel[0] / hs, s.vel[2] / hs, T);
  else if (s.crouch && hs >= T.slideMin) s.mode = 'slide';
  else s.mode = 'ground';
}
function startRoll(s, dx, dz, T) {
  const sp = Math.max(hspeed(s.vel), T.rollSpeed);
  s.vel[0] = dx * sp; s.vel[2] = dz * sp;
  s.mode = 'roll'; s.timer = 0; s.crouch = false;
}
function bulletJump(s, input, T) {
  const p = clamp(input.pitch ?? 0, T.bulletMinPitch, 1.2), yaw = input.yaw ?? 0;
  s.vel.splice(0, 3, Math.sin(yaw) * Math.cos(p) * T.bullet, Math.sin(p) * T.bullet, Math.cos(yaw) * Math.cos(p) * T.bullet); // in place: step holds s.vel
  s.mode = 'air'; s.grounded = false; s.crouch = false; s.jumpsLeft = 1; s.jumpKind = 'bullet';
}

/**
 * One physics step. input: { x, z (move right / forward, -1..1, relative to the camera), yaw, pitch (camera, rad,
 * pitch > 0 looks up), jump, crouch, sprint, aim, dodge (held booleans) }. Returns a new state; s is not changed.
 */
export function step(prev, input = {}, dt = 1 / 60, world = ARENA, T = TUNE) {
  const s = structuredClone(prev);
  dt = Math.min(dt, 1 / 30);
  const v = s.vel;
  const pressed = (k) => Boolean(input[k]) && !s.held[k];
  let jumpNow = pressed('jump'); // cleared once used, so one press is one jump
  const dodgeNow = pressed('dodge');
  s.held = { jump: Boolean(input.jump), dodge: Boolean(input.dodge) };
  s.wallLock = Math.max(0, s.wallLock - dt);

  // What the keys ask for, as a world direction on the ground.
  const yaw = input.yaw ?? 0, fx = Math.sin(yaw), fz = Math.cos(yaw);
  const mx = input.x || 0, mz = input.z || 0;
  let wx = fx * mz - fz * mx, wz = fz * mz + fx * mx;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const moving = wl > 0.1;

  if (s.mode === 'climb') {
    s.timer += dt;
    const f = Math.min(1, s.timer / T.climbTime), up = Math.min(1, f / 0.6), over = Math.max(0, (f - 0.6) / 0.4);
    const { from, to } = s.climb;
    s.pos = [from[0] + (to[0] - from[0]) * over, from[1] + (to[1] - from[1]) * up, from[2] + (to[2] - from[2]) * over];
    if (f >= 1) { s.climb = null; s.vel = [0, 0, 0]; land(s, 0, T); }
    return s;
  }

  const hs = hspeed(v);
  if (s.mode === 'roll') {
    s.timer += dt;
    if (s.timer >= T.rollTime) s.mode = s.grounded ? 'ground' : 'air';
  } else if (s.grounded) {
    s.crouch = Boolean(input.crouch);
    if (jumpNow && input.crouch) { bulletJump(s, input, T); jumpNow = false; }
    else if (jumpNow) { jumpNow = false; v[1] = T.jump; s.mode = 'air'; s.grounded = false; s.jumpKind = 'jump'; s.crouch = false; }
    else if (dodgeNow) startRoll(s, moving ? wx : Math.sin(s.yaw), moving ? wz : Math.cos(s.yaw), T);
    else if (s.mode === 'slide' && !s.crouch) s.mode = 'ground';
    else if (s.mode === 'slide') {
      const sp = Math.max(0, hs - T.slideFriction * dt);
      if (sp < T.slideStop) s.mode = 'ground';
      let dx = v[0], dz = v[2];
      if (moving) { dx += wx * hs * 1.5 * dt; dz += wz * hs * 1.5 * dt; } // a little steering
      const dl = Math.hypot(dx, dz) || 1;
      v[0] = (dx / dl) * sp; v[2] = (dz / dl) * sp;
    } else if (s.crouch && hs >= T.slideMin) s.mode = 'slide';
    else {
      const sp = s.crouch ? T.crouchSpeed : input.sprint ? T.sprint : T.run;
      steerTo(v, wx * sp, wz * sp, T.accel * dt);
    }
  } else if (s.mode === 'wallrun') {
    s.timer += dt;
    const n = s.wall.n;
    if (jumpNow) { // kick off the wall
      const into = v[0] * n[0] + v[2] * n[1];
      v[0] += n[0] * (T.wallKick - into); v[2] += n[1] * (T.wallKick - into); v[1] = T.jump;
      s.mode = 'air'; s.jumpsLeft = 1; s.jumpKind = 'wall'; jumpNow = false; s.wallLock = T.wallLock; s.wall = null;
    } else if (input.crouch || s.timer >= T.wallrunTime) { s.mode = 'air'; s.wallLock = T.wallLock; s.wall = null; }
    else {
      v[1] -= T.wallGravity * dt;
      const into = v[0] * n[0] + v[2] * n[1]; // keep pressing into the wall so it stays touched
      v[0] += n[0] * (-1.5 - into); v[2] += n[1] * (-1.5 - into);
    }
  }
  if (!s.grounded && s.mode === 'air') {
    s.crouch = Boolean(input.crouch); // held on landing: slide
    if (jumpNow && s.jumpsLeft > 0) {
      s.jumpsLeft--; v[1] = T.doubleJump; s.jumpKind = 'double';
      if (moving) { const sp = Math.max(hspeed(v), T.run); v[0] = wx * sp; v[2] = wz * sp; }
    }
    if (moving) { const sp = Math.max(T.run, hspeed(v)); steerTo(v, wx * sp, wz * sp, T.airAccel * dt); }
    v[1] = Math.max(v[1] - T.gravity * dt, -T.maxFall);
    s.gliding = Boolean(input.aim) && v[1] < 0 && s.glideLeft > 0;
    if (s.gliding) {
      s.glideLeft = Math.max(0, s.glideLeft - dt);
      v[1] = Math.max(v[1], -T.glideFall);
      v[0] *= 1 - T.glideDrag * dt; v[2] *= 1 - T.glideDrag * dt;
    }
  } else s.gliding = false;
  if (s.mode === 'roll' && !s.grounded) v[1] = Math.max(v[1] - T.gravity * dt, -T.maxFall);

  // Move: across first (walls), then up and down (ground).
  const vin = [v[0], v[2]];
  const feet0 = s.pos[1], wasGrounded = s.grounded;
  s.pos[0] += v[0] * dt; s.pos[2] += v[2] * dt;
  const wall = pushOut(world, s.pos, feet0, T);
  if (wall) { const d = v[0] * wall.n[0] + v[2] * wall.n[1]; if (d < 0) { v[0] -= wall.n[0] * d; v[2] -= wall.n[1] * d; } }
  s.pos[1] += v[1] * dt;
  const g = groundAt(world, s.pos[0], s.pos[2], feet0 + T.step, T.radius * 0.6);
  if (s.pos[1] <= g) {
    s.pos[1] = g;
    if (v[1] <= 0) { const impact = v[1]; if (!wasGrounded) land(s, impact, T); else { v[1] = 0; s.grounded = true; } }
  } else if (wasGrounded && v[1] <= 0 && s.pos[1] - g <= T.step) { s.pos[1] = g; v[1] = 0; }
  else if (s.grounded) { s.grounded = false; if (s.mode !== 'roll') s.mode = 'air'; } // walked off an edge

  // Touching a wall in the air: climb a ledge in reach, or run along a tall wall when moving fast beside it.
  if (s.mode === 'wallrun' && !wall) { s.mode = 'air'; s.wall = null; }
  if (wall && s.mode === 'air' && !s.grounded && s.wallLock === 0) {
    const n = wall.n;
    const ledge = findLedge(world, s.pos, [-n[0], -n[1]], T);
    const push = wx * -n[0] + wz * -n[1];
    const along = Math.hypot(vin[0] - n[0] * (vin[0] * n[0] + vin[1] * n[1]), vin[1] - n[1] * (vin[0] * n[0] + vin[1] * n[1]));
    if (ledge && push > 0.3) {
      s.mode = 'climb'; s.timer = 0; s.climb = { from: [...s.pos], to: ledge.to }; s.vel = [0, 0, 0];
      s.yaw = Math.atan2(-n[0], -n[1]); s.gliding = false;
      return s;
    }
    if (!ledge && moving && along >= T.wallrunMin && wall.top > s.pos[1] + T.height) {
      s.mode = 'wallrun'; s.timer = 0; s.wall = { n }; s.jumpsLeft = 1; s.glideLeft = T.glideTime; s.gliding = false;
      v[1] = Math.max(v[1], T.wallUp);
    }
  }

  // Face where we're going (or where the camera looks while gliding).
  const nhs = hspeed(s.vel);
  if (s.gliding) s.yaw = turnTo(s.yaw, yaw, T.turnRate * dt);
  else if (nhs > 0.5) s.yaw = turnTo(s.yaw, Math.atan2(s.vel[0], s.vel[2]), T.turnRate * dt);
  s.sprint = Boolean(input.sprint) && s.grounded && s.mode === 'ground' && nhs > T.run + 0.5;
  return s;
}

// --- animation state machine ---
export const STATES = ['idle', 'run', 'sprint', 'crouch', 'jump', 'fall', 'slide', 'wallrun', 'glide', 'roll', 'climb'];
/** The animation state for a physics state. */
export function animState(s) {
  if (['climb', 'roll', 'slide', 'wallrun'].includes(s.mode)) return s.mode;
  if (s.grounded) {
    if (s.crouch) return 'crouch';
    const hs = hspeed(s.vel);
    return hs < 0.3 ? 'idle' : s.sprint ? 'sprint' : 'run';
  }
  if (s.gliding) return 'glide';
  return s.vel[1] > 0 ? 'jump' : 'fall';
}
export const LABELS = {
  idle: 'Standing', run: 'Running', sprint: 'Sprinting', crouch: 'Crouching', jump: 'Jumping', fall: 'Falling',
  slide: 'Sliding', wallrun: 'Wall running', glide: 'Gliding', roll: 'Rolling', climb: 'Climbing up',
};
const JUMP_LABELS = { double: 'Double jump', bullet: 'Bullet jump', wall: 'Wall jump' };
export const stateLabel = (state, s) => (state === 'jump' && JUMP_LABELS[s.jumpKind]) || LABELS[state];

export const newAnim = () => ({ state: 'idle', prev: 'idle', t: 0, phase: 0 });
/** Advance the animation: state (with the one before and time in it) and the stride cycle (0..1). */
export function stepAnim(a, s, dt) {
  const state = animState(s);
  const changed = state !== a.state;
  const stride = state === 'sprint' ? 2.6 : state === 'crouch' ? 1.1 : 1.9; // metres per full cycle
  const hs = state === 'wallrun' ? hspeed(s.vel) : s.grounded ? hspeed(s.vel) : 0;
  return { state, prev: changed ? a.state : a.prev, t: changed ? 0 : a.t + dt, phase: (a.phase + (hs * dt) / stride) % 1 };
}

// --- procedural poses ---
// A pose is angles in degrees, in the character's own frame (+z forward): lean (spine forward), head (nod), tilt
// (whole body sideways, + to its left), spin (whole body forward roll), plant (0..1: drop the body so the lower
// foot stays on the floor). Arms [raise sideways (0 = hanging), swing forward, elbow bend]; legs [swing forward,
// knee bend, splay out].
const POSE0 = { lean: 0, head: 0, tilt: 0, spin: 0, plant: 1, lArm: [12, 0, 10], rArm: [12, 0, 10], lLeg: [0, 0, 3], rLeg: [0, 0, 3] };
const TAU = Math.PI * 2;
function gait(phase, amp, lean, elbow, knee) {
  const c = Math.sin(phase * TAU), k = (o) => knee * 0.3 + knee * Math.max(0, Math.cos(phase * TAU + o)); // bend while the leg swings through
  return { lean, lArm: [14, -amp * 0.8 * c, elbow], rArm: [14, amp * 0.8 * c, elbow], lLeg: [amp * c, k(0), 3], rLeg: [-amp * c, k(Math.PI), 3] };
}
/** anim: { state, t, phase }. s: the physics state (wall side, climb and roll progress). */
export function poseFor(anim, s = {}, T = TUNE) {
  const { state, t = 0, phase = 0 } = anim;
  const p = (o) => ({ ...POSE0, ...o });
  switch (state) {
    case 'run': return p(gait(phase, 35, 10, 70, 60));
    case 'sprint': return p(gait(phase, 50, 22, 90, 80));
    case 'crouch': { const g = gait(phase, 15, 25, 40, 20); return p({ ...g, lLeg: [55 + g.lLeg[0], 95, 8], rLeg: [55 + g.rLeg[0], 95, 8] }); }
    case 'jump':
      if (s.jumpKind === 'bullet') return p({ plant: 0, lean: 60, head: -30, lArm: [25, -45, 10], rArm: [25, -45, 10], lLeg: [-15, 15, 4], rLeg: [-10, 25, 4] });
      return p({ plant: 0, spin: s.jumpKind === 'double' ? -360 * Math.min(1, t / 0.45) : 0, lean: 5, lArm: [35, 40, 40], rArm: [35, 40, 40], lLeg: [45, 75, 5], rLeg: [15, 35, 5] });
    case 'fall': return p({ plant: 0, lArm: [60, 10, 20], rArm: [60, 10, 20], lLeg: [15, 25, 5], rLeg: [-5, 15, 5] });
    case 'slide': return p({ lean: -25, head: 20, lArm: [40, -20, 30], rArm: [40, -20, 30], lLeg: [70, 10, 6], rLeg: [20, 100, 6] });
    case 'wallrun': {
      const n = s.wall?.n || [1, 0], yaw = s.yaw || 0;
      const left = n[0] * Math.cos(yaw) - n[1] * Math.sin(yaw) < 0; // the wall is on the body's left (left = [cos yaw, -sin yaw])
      return p({ ...gait(phase, 45, 12, 80, 70), tilt: left ? 20 : -20 });
    }
    case 'glide': return p({ plant: 0, lean: 35, head: -25, lArm: [75, -10, 10], rArm: [75, -10, 10], lLeg: [-10, 20, 8], rLeg: [5, 30, 8] });
    case 'roll': {
      const f = Math.min(1, t / T.rollTime);
      return p({ plant: 0, spin: 360 * f, lean: 40, lArm: [20, 60, 90], rArm: [20, 60, 90], lLeg: [80, 120, 5], rLeg: [80, 120, 5] });
    }
    case 'climb': {
      const f = Math.min(1, t / T.climbTime);
      return p({ plant: 0, lean: 20, lArm: [15, 160 - 140 * f, 20], rArm: [15, 160 - 140 * f, 20], lLeg: [70 * (1 - f), 90 * (1 - f), 5], rLeg: [20, 40, 5] });
    }
    default: { const b = Math.sin(t * 2); return p({ lean: 2 + b, lArm: [12, 0, 10 + 3 * b], rArm: [12, 0, 10 + 3 * b] }); } // idle: breathing
  }
}
/** Blend two poses: f = 0 is a, 1 is b. */
export function mixPose(a, b, f) {
  const out = {};
  for (const k of Object.keys(b)) out[k] = Array.isArray(b[k]) ? b[k].map((v, i) => a[k][i] + (v - a[k][i]) * f) : a[k] + (b[k] - a[k]) * f;
  return out;
}
/** Bring an old pose's spin within a half turn of the new one, so a finished flip doesn't unwind backwards. */
export const wrapSpin = (from, to) => ({ ...from, spin: to.spin + (((from.spin - to.spin) % 360) + 540) % 360 - 180 });
