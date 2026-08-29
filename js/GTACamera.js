import * as THREE from 'three';

// GTA IV over-the-shoulder camera
// - Pivot at character shoulder height
// - Mouse X → yaw, Mouse Y → pitch
// - Spring-arm follow with soft lag
// - Character body turns toward camera yaw when moving

const SHOULDER_RIGHT  =  0.45;  // right offset of pivot from character centre
const SHOULDER_HEIGHT =  1.55;  // eye-ish height
const ARM_LENGTH      =  3.2;   // default camera distance
const MIN_PITCH       = -0.32;  // radians (~-18°) look-down limit
const MAX_PITCH       =  0.52;  // radians (~+30°) look-up limit
const FOV             =  62;
const SPRING_K        =  8.0;   // position spring stiffness
const ROT_SPRING_K    = 12.0;   // rotation spring stiffness

export class GTACamera {
  constructor(camera) {
    this.camera = camera;
    camera.fov = FOV;
    camera.updateProjectionMatrix();

    this.yaw       = 0;        // radians, world Y rotation of camera
    this.pitch     = 0.15;     // radians, tilt

    this._position  = new THREE.Vector3();  // smoothed camera world position
    this._target    = new THREE.Vector3();  // smoothed look-at target
    this._firstFrame = true;

    // Mouse sensitivity
    this.sensitivity = 0.0022;

    // Collision check (simple raycast)
    this._raycaster = new THREE.Raycaster();
    this._collidables = [];
  }

  setCollidables(meshes) { this._collidables = meshes; }

  onMouseMove(dx, dy) {
    this.yaw   -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch  = THREE.MathUtils.clamp(this.pitch, MIN_PITCH, MAX_PITCH);
  }

  // Call every frame; returns desired character yaw (world)
  update(dt, characterPos) {
    // Pivot: slightly to the right of character at shoulder height
    const camRight = new THREE.Vector3(
      Math.sin(this.yaw + Math.PI * 0.5), 0,
      Math.cos(this.yaw + Math.PI * 0.5)
    );
    const pivotPos = characterPos.clone()
      .addScaledVector(camRight, SHOULDER_RIGHT)
      .add(new THREE.Vector3(0, SHOULDER_HEIGHT, 0));

    // Camera direction from pitch and yaw
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);

    // Back-offset along camera direction
    const camDir = new THREE.Vector3(-sinY * cosP, sinP, -cosY * cosP).normalize();
    let armLen = ARM_LENGTH;

    // Simple sphere-cast: step back and check for terrain collision
    armLen = this._resolveArmLength(pivotPos, camDir, ARM_LENGTH);

    const desiredPos = pivotPos.clone().addScaledVector(camDir, -armLen);

    // Look-at target: slightly above character mid
    const desiredTarget = characterPos.clone().add(new THREE.Vector3(0, SHOULDER_HEIGHT * 0.6, 0));

    if (this._firstFrame) {
      this._position.copy(desiredPos);
      this._target.copy(desiredTarget);
      this._firstFrame = false;
    } else {
      // Spring follow
      const k = 1 - Math.exp(-SPRING_K * dt);
      this._position.lerp(desiredPos, k);
      this._target.lerp(desiredTarget, 1 - Math.exp(-ROT_SPRING_K * dt));
    }

    this.camera.position.copy(this._position);
    this.camera.lookAt(this._target);

    return this.yaw;  // caller uses this to orient character
  }

  _resolveArmLength(pivot, camDir, maxLen) {
    if (this._collidables.length === 0) return maxLen;
    // Raycast from pivot backward along -camDir
    this._raycaster.set(pivot, camDir.clone().negate());
    this._raycaster.far = maxLen + 0.5;
    const hits = this._raycaster.intersectObjects(this._collidables, false);
    if (hits.length > 0) {
      return Math.max(0.5, hits[0].distance - 0.3);
    }
    return maxLen;
  }
}
