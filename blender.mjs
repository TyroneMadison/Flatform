// Finding Blender on this computer. Blender is optional and never bundled. On Windows it is the installer's
// Program Files folder on any drive, Steam, a portable zip unpacked in the home folder (or a Blender folder in it),
// or anything on PATH. Pure apart from the file system calls, which tests replace.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { detectModelType, mapBones, poseBones, POSES } from './public/lib/motion.js';

const realDrives = () => {
  const out = [];
  for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; if (existsSync(d)) out.push(d); } // C: to Z:
  return out;
};

/** Every place Blender may be, best first. fs: { readdir, drives } for tests. */
export function blenderCandidates(platform = process.platform, env = process.env, { readdir = readdirSync, drives = realDrives } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return ['/Applications/Blender.app/Contents/MacOS/Blender', p.join(env.HOME || os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender')];
  const onPath = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
    .map((d) => p.join(d, platform === 'win32' ? 'blender.exe' : 'blender'));
  if (platform !== 'win32') return [...onPath, '/usr/bin/blender', '/snap/bin/blender'];
  // Newest version first inside each folder that holds versioned Blender folders.
  const versions = (base) => {
    let dirs = [];
    try { dirs = readdir(base).filter((d) => /^blender/i.test(d)); } catch { /* not there */ }
    return dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((d) => p.join(base, d, 'blender.exe'));
  };
  const home = env.USERPROFILE || os.homedir();
  const ds = drives();
  const programFiles = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], ...ds.flatMap((d) => [`${d}Program Files`, `${d}Program Files (x86)`])].filter(Boolean))];
  const steam = [...new Set([env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'Steam'), ...ds.flatMap((d) => [`${d}SteamLibrary`, `${d}Steam`])].filter(Boolean))];
  return [...new Set([
    ...versions(p.join(home, 'Blender')), ...versions(home), // portable zips, e.g. %USERPROFILE%\Blender\blender-5.2.2-windows-x64
    ...programFiles.flatMap((d) => versions(p.join(d, 'Blender Foundation'))),
    ...steam.map((s) => p.join(s, 'steamapps', 'common', 'Blender', 'blender.exe')),
    ...(env.LOCALAPPDATA ? versions(p.join(env.LOCALAPPDATA, 'Programs')) : []),
    ...onPath,
    ...(env.LOCALAPPDATA ? [p.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'blender.exe')] : []), // Microsoft Store alias
  ])];
}

/** The Blender to use: the one picked in Settings if it is still there, else the first one found. */
export function findBlender(configured, { candidates = blenderCandidates(), exists = existsSync } = {}) {
  return [configured, ...candidates].find((f) => f && exists(f)) || null;
}

/** "5.2.2" from `Blender 5.2.2 LTS` (blender --version), or from a folder name like blender-5.2.2-windows-x64. */
export function parseVersion(text) {
  return String(text || '').match(/blender[\s-]*(\d+\.\d+(?:\.\d+)?)/i)?.[1] || null;
}

// ponytail: cached per path and file time for the session; a new Blender in the same place restarts the app anyway.
const versionCache = new Map();
/** Blender's version, asked from the program itself (well under a second), else read off its folder name. */
export async function blenderVersion(bin, { run = execFile } = {}) {
  if (!bin) return null;
  let key = bin;
  try { key += statSync(bin).mtimeMs; } catch { /* gone: still try the name */ }
  if (versionCache.has(key)) return versionCache.get(key);
  const fromName = parseVersion(path.basename(path.dirname(bin))) || parseVersion(bin);
  const asked = /\.m?js$/i.test(bin) ? null // a test stand-in, not a program
    : await new Promise((ok) => run(bin, ['--version'], { timeout: 15000, windowsHide: true }, (e, out) => ok(e ? null : parseVersion(out))));
  const v = asked || fromName;
  versionCache.set(key, v);
  return v;
}

/** Node names in a GLB: skin joints (bones) and meshes. */
export function glbNames(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') return { bones: [], meshes: [] };
  const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const nodes = json.nodes || [];
  const joints = new Set((json.skins || []).flatMap((s) => s.joints || []));
  return { bones: [...joints].map((i) => nodes[i]?.name).filter(Boolean), meshes: nodes.filter((n) => n.mesh !== undefined).map((n) => n.name || '') };
}

/**
 * What render/blender_turntable.py gets as --pose for a still: the Compose pose (preset plus Pose by hand bones and
 * hips) with the standard bone names swapped for the model's own, as rig.js applyMotion does in the app. Null when
 * there is nothing to pose. bones: { name: [x, y, z] } three.js Euler degrees on top of the rest pose;
 * hips: [x, y, z] metres in the turntable's space (Y up).
 */
export function blenderPose(glb, motion) {
  if (!motion?.pose?.preset) return null;
  const { bones, meshes } = glbNames(glb);
  if (detectModelType({ boneNames: bones, partNames: meshes }, motion.type || 'auto').type !== 'humanoid') return null;
  const map = mapBones(bones);
  const euler = poseBones(POSES[motion.pose.preset] ? motion.pose.preset : 'tpose', motion.pose.bones || {});
  const out = Object.fromEntries(Object.entries(euler).filter(([std, v]) => map[std] && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)).map(([std, v]) => [map[std], v]));
  const hips = Array.isArray(motion.pose.hips) && motion.pose.hips.length === 3 && motion.pose.hips.every(Number.isFinite) && motion.pose.hips.some(Boolean) && map.Hips ? { bone: map.Hips, offset: motion.pose.hips } : null;
  return Object.keys(out).length || hips ? { bones: out, hips } : null;
}
