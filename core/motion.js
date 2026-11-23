// How characters and creatures move on screen. The game moves a holder (core/assets.js); the model
// inside faces where the holder travels and its clips play in place.
//
//   faceTravel(holder, velocity, delta)   turn toward horizontal travel by the shortest way
//   inPlace(clip)                         a copy of a clip with the root's ground travel removed
//   damp(camera.position, goal, 6, delta) ease toward a goal the same way at any frame rate
import * as THREE from "three";

/**
 * Moves `current` toward `target` by the same share each second at any frame rate: with
 * `sharpness` 6 it closes about 95% of the gap in half a second. `current` is a number (the
 * result is returned) or a Vector2 or Vector3, changed in place. A fixed `lerp(…, 0.1)` per frame
 * eases twice as fast at 120 Hz as at 60 Hz; use this for follow cameras and smoothed values.
 */
export function damp(current, target, sharpness, delta) {
  const share = 1 - Math.exp(-sharpness * delta);
  if (typeof current === "number") {
    return current + (target - current) * share;
  }
  return current.lerp(target, share);
}

/**
 * Turns `object` about y toward its horizontal travel (+z is its front), at most `turnRate`
 * radians a second, by the shorter way round. Below `minSpeed` it keeps the heading it had, so a
 * character that stops does not swing back to face the camera.
 */
export function faceTravel(object, velocity, delta, { turnRate = 12, minSpeed = 0.05 } = {}) {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < minSpeed) {
    return object.rotation.y;
  }
  const target = Math.atan2(velocity.x, velocity.z);
  const difference =
    THREE.MathUtils.euclideanModulo(target - object.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
  const turn = THREE.MathUtils.clamp(difference, -turnRate * delta, turnRate * delta);
  object.rotation.y += turn;
  return object.rotation.y;
}

const ROOT_BONE = /(^|[^a-z])(root|hips?|pelvis)([^a-z]|$)/i;

/**
 * Removes ground travel (x and z) from the root or hip bone's position track, keeping the bob in
 * y. Library walk and run clips that travel make the model slide away from its holder and its
 * collider; the game moves the holder instead. `rootBone` names the bone when the rig's is not
 * called root, hips or pelvis: its exact name, or a pattern.
 */
export function inPlace(clip, rootBone = ROOT_BONE) {
  const isRoot =
    typeof rootBone === "string" ? (name) => name === rootBone : (name) => rootBone.test(name);
  const copy = clip.clone();
  for (const track of copy.tracks) {
    const [node, property] = track.name.split(".");
    if (property !== "position" || !isRoot(node)) {
      continue;
    }
    const values = track.values;
    const [x0, , z0] = values;
    for (let index = 0; index < values.length; index += 3) {
      values[index] = x0;
      values[index + 2] = z0;
    }
  }
  return copy;
}
