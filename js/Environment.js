import * as THREE from 'three';
import { getTerrainHeight } from './Terrain.js';

/**
 * The collidable set: what the character can bump into and put a hand on.
 *
 * Every obstacle is an axis-aligned box, which buys two things. Collision is a
 * circle-vs-AABB push-out with no solver and no tunnelling at walking speeds,
 * and the hand placement raycast is an analytic slab test — no BVH, no
 * `THREE.Raycaster` against a mesh, and it runs headless, so the wall behaviour
 * is testable without a GPU.
 *
 * The staging stays an Euphoria tech demo: grey primitives in a white void. They
 * are here to be *reacted to*, not to be scenery.
 */

const WALL_COLOR  = 0x5c5c62;
const BLOCK_COLOR = 0x54545a;

export class BoxCollider {
  /**
   * @param {THREE.Vector3} min
   * @param {THREE.Vector3} max
   */
  constructor(min, max, name = 'box') {
    this.min = min.clone();
    this.max = max.clone();
    this.name = name;
  }

  get top() { return this.max.y; }

  /**
   * Push a vertical capsule (modelled as a circle in XZ) clear of this box.
   * Mutates `pos`.
   * @returns {{normal:THREE.Vector3, depth:number}|null}
   */
  resolveCircle(pos, radius) {
    // Only bodies that overlap vertically can be touched.
    if (pos.y > this.max.y || pos.y + 1.6 < this.min.y) return null;

    const cx = THREE.MathUtils.clamp(pos.x, this.min.x, this.max.x);
    const cz = THREE.MathUtils.clamp(pos.z, this.min.z, this.max.z);
    let dx = pos.x - cx;
    let dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) return null;

    let nx, nz, depth;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nx = dx / d; nz = dz / d;
      depth = radius - d;
    } else {
      // Centre is inside the box: leave through the shallowest face.
      const dists = [
        { axis: 'x', n:  1, d: this.max.x - pos.x },
        { axis: 'x', n: -1, d: pos.x - this.min.x },
        { axis: 'z', n:  1, d: this.max.z - pos.z },
        { axis: 'z', n: -1, d: pos.z - this.min.z },
      ].sort((a, b) => a.d - b.d);
      const best = dists[0];
      nx = best.axis === 'x' ? best.n : 0;
      nz = best.axis === 'z' ? best.n : 0;
      depth = best.d + radius;
    }

    pos.x += nx * depth;
    pos.z += nz * depth;
    return { normal: new THREE.Vector3(nx, 0, nz), depth };
  }

  /**
   * Slab test. Returns the entry hit, or null.
   * @returns {{distance:number, point:THREE.Vector3, normal:THREE.Vector3, box:BoxCollider}|null}
   */
  intersectRay(origin, dir, maxDist) {
    let tmin = 0, tmax = maxDist;
    let hitAxis = -1, hitIsMinFace = true;

    for (let a = 0; a < 3; a++) {
      const o = origin.getComponent(a);
      const d = dir.getComponent(a);
      const lo = this.min.getComponent(a);
      const hi = this.max.getComponent(a);

      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return null;   // parallel and outside the slab
        continue;
      }

      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let isMin = true;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; isMin = false; }

      if (t1 > tmin) { tmin = t1; hitAxis = a; hitIsMinFace = isMin; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (hitAxis < 0) return null;             // origin inside: no entry face
    if (tmin > maxDist || tmin < 0) return null;

    const normal = new THREE.Vector3();
    normal.setComponent(hitAxis, hitIsMinFace ? -1 : 1);
    return {
      distance: tmin,
      point: origin.clone().addScaledVector(dir, tmin),
      normal,
      box: this,
    };
  }
}

/**
 * Stage set, in world units. `h` is height above the floor; the footprint is
 * centred on (x, z) with the given width (x) and depth (z).
 */
const LAYOUT = [
  // The wall you walk into: dead ahead of the spawn, chest-high enough that a
  // hand lands on its face rather than over the top.
  { name: 'wall',    x: 0,    z: -6.0, w: 14.0, d: 0.4, h: 3.0, color: WALL_COLOR },
  // Waist-high rail — hands end up resting on top of it.
  { name: 'rail',    x: -6.0, z: -2.6, w: 3.4,  d: 0.35, h: 1.05, color: WALL_COLOR },
  // Pillars to brush past.
  { name: 'pillarA', x: -3.1, z: -1.6, w: 0.9,  d: 0.9, h: 2.8, color: BLOCK_COLOR },
  { name: 'pillarB', x:  3.4, z: -2.8, w: 0.9,  d: 0.9, h: 2.8, color: BLOCK_COLOR },
  // A crate stack behind the spawn, so turning around finds something too.
  { name: 'crate',   x:  1.6, z:  3.4, w: 1.6,  d: 1.6, h: 1.7, color: BLOCK_COLOR },
];

export class Environment {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.colliders = [];
    this.meshes = [];
    this.group = new THREE.Group();
    this.group.name = 'Environment';
    scene.add(this.group);

    for (const def of LAYOUT) {
      const groundY = getTerrainHeight(def.x, def.z);
      const min = new THREE.Vector3(def.x - def.w / 2, groundY, def.z - def.d / 2);
      const max = new THREE.Vector3(def.x + def.w / 2, groundY + def.h, def.z + def.d / 2);
      this.colliders.push(new BoxCollider(min, max, def.name));

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(def.w, def.h, def.d),
        new THREE.MeshLambertMaterial({ color: def.color })
      );
      mesh.position.set(def.x, groundY + def.h / 2, def.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = def.name;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    // Make the meshes queryable straight away. The camera's spring arm raycasts
    // against them on the first frame, before the renderer has ever updated a
    // world matrix, and a raycaster reads matrixWorld rather than recomputing it.
    this.group.updateMatrixWorld(true);
  }

  /**
   * Push the character out of everything it overlaps.
   * @param {THREE.Vector3} pos  mutated in place
   * @param {number} radius
   * @returns {THREE.Vector3|null} the contact normal of the deepest push, for
   *   killing the velocity component that drove him into the wall
   */
  resolveCharacter(pos, radius) {
    let deepest = null;
    for (const c of this.colliders) {
      const hit = c.resolveCircle(pos, radius);
      if (hit && (!deepest || hit.depth > deepest.depth)) deepest = hit;
    }
    return deepest ? deepest.normal : null;
  }

  /**
   * Nearest box hit along a ray.
   * @returns {{distance:number, point:THREE.Vector3, normal:THREE.Vector3, box:BoxCollider}|null}
   */
  raycast(origin, dir, maxDist) {
    let best = null;
    for (const c of this.colliders) {
      const hit = c.intersectRay(origin, dir, maxDist);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }
}
