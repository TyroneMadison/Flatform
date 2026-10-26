// Builds an environment (environments.js) as three.js geometry: a group of meshes and area lights in world space,
// so the place turns with the camera like any 3D object. No renderer needed (the sky and reflections are set up
// by studio.js); render/blender_turntable.py build_environment mirrors this part for part.
import * as THREE from 'three';
import { envParts } from './environments.js';

const rad = THREE.MathUtils.degToRad;

export function envMaterial({ color, rough = 0.8, metal = 0, emit = 0 }, side = THREE.FrontSide) {
  if (emit > 0) return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(emit), side });
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, side });
}

// Floor curving up into the back wall (an infinity cove): profile in (z, y), extruded across x.
function cycGeometry([w, h, r, front], z0) {
  const profile = [[z0 + front, 0], [z0 + r, 0]];
  for (let i = 1; i <= 16; i++) { const a = (i / 16) * (Math.PI / 2); profile.push([z0 + r - r * Math.sin(a), r - r * Math.cos(a)]); }
  profile.push([z0, h]);
  const geo = new THREE.PlaneGeometry(w, 1, 1, profile.length - 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const [z, y] = profile[Math.floor(i / 2)];
    pos.setXYZ(i, i % 2 ? w / 2 : -w / 2, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

// loadGlb(file) → Promise<Object3D> for { glb } parts (bundled CC0 models); without it they are skipped.
export async function buildEnvironment(spec, { loadGlb } = {}) {
  const group = new THREE.Group();
  group.name = 'environment';
  const mats = Object.fromEntries(Object.entries(spec.mats).map(([k, m]) => [k, envMaterial(m)]));
  const inward = (k) => envMaterial(spec.mats[k], THREE.BackSide);
  for (const p of envParts(spec)) {
    let o;
    if (p.room) {
      const [w, h, d] = p.room;
      const walls = inward(p.walls);
      // BoxGeometry face order: +x, -x, +y (ceiling), -y (floor), +z, -z. Seen from inside only.
      o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [walls, walls, inward(p.ceiling), inward(p.floor), walls, walls]);
      o.position.set(p.at[0], h / 2, p.at[1]);
    } else if (p.cyc) {
      o = new THREE.Mesh(cycGeometry(p.cyc, p.at[1]), envMaterial(spec.mats[p.mat], THREE.DoubleSide));
      o.position.x = p.at[0];
    } else if (p.glb) {
      if (!loadGlb) continue;
      o = await loadGlb(p.glb);
      o.position.set(...p.at);
      o.scale.setScalar(p.scale ?? 1);
    } else {
      const geo = p.box ? new THREE.BoxGeometry(...p.box)
        : p.cyl ? new THREE.CylinderGeometry(p.cyl[0], p.cyl[1], p.cyl[2], 24)
          : new THREE.TorusGeometry(p.ring[0], p.ring[1], 12, 320).rotateX(Math.PI / 2);
      o = new THREE.Mesh(geo, mats[p.mat]);
      o.position.set(...p.at);
    }
    if (p.rot) o.rotation.set(rad(p.rot[0]), rad(p.rot[1]), rad(p.rot[2]));
    group.add(o);
  }
  for (const l of spec.lights) {
    const light = new THREE.RectAreaLight(l.color, l.power, l.area[0], l.area[1]);
    light.position.set(...l.at);
    light.lookAt(...l.aim);
    group.add(light);
  }
  return group;
}
