import * as THREE from 'three';

// Euphoria tech-demo staging: a flat neutral floor under a white void, with no
// landscape to read as a place. The height field is kept behind RELIEF so the
// rolling terrain can be brought back by raising it above zero — the foot
// planting and slope adaptation still work either way.
export const RELIEF = 0;

const SIZE = 220;   // wide enough that the edge is lost in fog long before it
const SEGS = 200;   // only needed when RELIEF > 0; a flat floor needs no tessellation

const FLOOR_COLOR = 0x4c4c50;   // slightly dark grey, faintly cool

export function getTerrainHeight(x, z) {
  if (RELIEF === 0) return 0;
  return RELIEF * (
    Math.sin(x * 0.12) * 1.4 +
    Math.cos(z * 0.10) * 1.1 +
    Math.sin(x * 0.35 + z * 0.28) * 0.5 +
    Math.cos(x * 0.55 - z * 0.47) * 0.3 +
    Math.sin(x * 0.9  + z * 0.7 ) * 0.12
  );
}

// Surface normal via central differences (used to sit the feet on slopes)
export function getTerrainNormal(x, z) {
  if (RELIEF === 0) return new THREE.Vector3(0, 1, 0);
  const eps = 0.05;
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);
  return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
}

export function createTerrain(scene) {
  const flat = RELIEF === 0;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, flat ? 1 : SEGS, flat ? 1 : SEGS);
  geo.rotateX(-Math.PI / 2);

  if (!flat) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, getTerrainHeight(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  const mat = new THREE.MeshLambertMaterial({ color: FLOOR_COLOR });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);

  return mesh;
}
