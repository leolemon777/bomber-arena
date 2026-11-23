// Effects a game picks by its subject, each lit by the game's lighting (lighting.js) so it sits in
// the same light as the rest of the scene:
//
//   const water = createWater(lighting, { width: 200, depth: 200, color: "#1d4f5c" })  // a lake, a sea
//   const rain = createRain(camera, { count: 8000 })                                   // weather
//   const fire = createFire({ height: 1.2 }); lighting.addEmitter(fire, { radius: 12 }) // a campfire
//
// Each returns an Object3D to add to the scene (rain follows the camera itself) with update(delta)
// for the game's update() and dispose().
import * as THREE from "three/webgpu";
import {
  cameraPosition,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  positionLocal,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { withEnvironmentLighting } from "./materials.js";

const RainMaterial = withEnvironmentLighting(THREE.MeshStandardNodeMaterial);

export { createWater } from "./water.js";

/**
 * Rain around the camera: streaks that fall through a box that follows it, each a function of its
 * index and the time, so nothing is simulated. It is lit by the sky's light it falls through.
 */
export function createRain(
  camera,
  { count = 8000, area = 40, height = 24, speed = 14, length = 0.9, opacity = 0.3 } = {},
) {
  const geometry = new THREE.PlaneGeometry(0.012, length);
  geometry.translate(0, -length / 2, 0);
  const material = new RainMaterial({
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
  });
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  const centre = uniform(new THREE.Vector3());
  const seed = float(instanceIndex);
  const box = vec3(hash(seed), hash(seed.add(17.3)), hash(seed.add(41.9)));
  const fall = fract(
    box.y.sub(time.mul(speed / height).mul(hash(seed.add(7.1)).mul(0.3).add(0.85))),
  );
  const local = vec3(
    box.x.sub(0.5).mul(area),
    fall.mul(height).sub(height * 0.3),
    box.z.sub(0.5).mul(area),
  );
  // Keep every streak in a box around the camera: wrap each axis into the box.
  const offset = local.add(centre);
  const wrapped = vec3(
    fract(offset.x.div(area)).sub(0.5).mul(area).add(centre.x),
    offset.y,
    fract(offset.z.div(area)).sub(0.5).mul(area).add(centre.z),
  );
  // Each streak turns to face the camera around the vertical, in the shader: the mesh itself
  // stays put, since turning it would swing the whole box of rain around the origin.
  const yaw = uniform(0);
  const facing = vec3(
    positionLocal.x.mul(cos(yaw)),
    positionLocal.y,
    positionLocal.x.mul(sin(yaw)).negate(),
  );
  material.positionNode = facing.add(wrapped);
  // A streak is brightest at its head and fades out with distance.
  const distance = wrapped.sub(cameraPosition).length();
  const fade = smoothstep(area * 0.5, area * 0.1, distance).mul(smoothstep(0.5, 2, distance));
  const edge = smoothstep(0.5, 0.1, uv().x.sub(0.5).abs());
  material.colorNode = vec3(0.75, 0.8, 0.9);
  material.opacityNode = uv().y.mul(opacity).mul(edge).mul(fade);
  const rain = new THREE.InstancedMesh(geometry, material, count);
  rain.frustumCulled = false;
  rain.userData.prewarm = true;
  const direction = new THREE.Vector3();
  rain.update = () => {
    centre.value.copy(camera.position);
    camera.getWorldDirection(direction);
    yaw.value = Math.atan2(-direction.x, -direction.z);
  };
  rain.dispose = () => {
    geometry.dispose();
    material.dispose();
  };
  return rain;
}

function fireResources(height, width, intensity) {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(0, height / 2, 0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const p = uv();
  const flow = mx_noise_float(vec3(p.x.mul(3), p.y.mul(2).sub(time.mul(2.2)), time.mul(0.6)));
  // The flame narrows upward; the noise eats its edge.
  const shape = smoothstep(0.5, 0.1, p.x.sub(0.5).abs().add(p.y.mul(0.35)).add(flow.mul(0.18)));
  const core = smoothstep(0.55, 0.0, p.y.add(flow.mul(0.2))).mul(
    smoothstep(0.22, 0.02, p.x.sub(0.5).abs().add(flow.mul(0.04))),
  );
  const color = mix(vec3(1.0, 0.33, 0.06), vec3(1.0, 0.85, 0.5), core);
  const heat = mix(0.1, 1, core.pow(4));
  material.colorNode = vec4(color.mul(heat).mul(intensity), shape.mul(smoothstep(1, 0.6, p.y)));
  return { geometry, material };
}

/** Face the camera around the parent's up axis, without changing the placement transform. */
function fireBillboard() {
  const direction = new THREE.Vector3();
  const up = new THREE.Vector3();
  const normalToLocal = new THREE.Matrix3();
  return (fire, cameraPosition) => {
    fire.getWorldPosition(direction);
    direction.subVectors(cameraPosition, direction);
    if (fire.parent) {
      const world = fire.parent.matrixWorld;
      up.setFromMatrixColumn(world, 1).normalize();
      direction.addScaledVector(up, -direction.dot(up));
      // Normals transform by inverse transpose; its inverse brings this world normal back
      // to the parent's coordinates, including non-uniform scale and nested transforms.
      direction.applyMatrix3(normalToLocal.setFromMatrix4(world).transpose());
    }
    fire.rotation.y = Math.atan2(direction.x, direction.z);
  };
}

/**
 * A flame: a camera-facing card whose shape and color flicker with noise, from white-yellow at the
 * base to deep orange at the tips. It is bright enough to bloom at night. Pair it with
 * lighting.addEmitter so it lights what is around it.
 */
export function createFire({ height = 1.2, width = 0.7, intensity = 6 } = {}) {
  const { geometry, material } = fireResources(height, width, intensity);
  const fire = new THREE.Mesh(geometry, material);
  fire.castShadow = false;
  const faceCamera = fireBillboard();
  const cameraPosition = new THREE.Vector3();
  let disposed = false;
  fire.update = (_delta, camera) => {
    if (camera && !disposed) faceCamera(fire, camera.getWorldPosition(cameraPosition));
  };
  fire.dispose = () => {
    if (disposed) return;
    disposed = true;
    fire.removeFromParent();
    geometry.dispose();
    material.dispose();
  };
  return fire;
}

/**
 * Preallocate unlit flames before runtime shader compilation. Add object to the scene, place
 * fires[i].object, then call fires[i].setStrength(0..1) to light each one independently. All
 * flames share one geometry and material. Zero strength keeps a tiny renderable card, even off
 * camera, so compileAsync warms it. Optional point lights stay in the scene at zero intensity;
 * they cast no shadows. Call update(delta, camera) each frame and dispose() when the pool ends.
 */
export function createFirePool({
  count = 1,
  height = 1.2,
  width = 0.7,
  intensity = 6,
  lightIntensity = 0,
  lightDistance = 14,
} = {}) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Fire count must be a non-negative integer.");
  }
  const { geometry, material } = fireResources(height, width, intensity);
  const object = new THREE.Group();
  const flames = [];
  const lights = [];
  const faceCamera = fireBillboard();
  const cameraPosition = new THREE.Vector3();
  let disposed = false;
  const fires = Array.from({ length: count }, () => {
    const placement = new THREE.Group();
    const flame = new THREE.Mesh(geometry, material);
    flame.frustumCulled = false;
    flame.castShadow = false;
    placement.add(flame);
    flames.push(flame);
    const light = lightIntensity > 0 ? new THREE.PointLight(0xff9a4a, 0, lightDistance) : null;
    if (light) {
      light.position.y = height / 2;
      light.castShadow = false;
      placement.add(light);
      lights.push(light);
    }
    object.add(placement);
    const setStrength = (value) => {
      if (disposed) return;
      const strength = THREE.MathUtils.clamp(value, 0, 1);
      flame.scale.setScalar(Math.max(0.0001, strength));
      if (light) light.intensity = lightIntensity * strength;
    };
    setStrength(0);
    return { object: placement, setStrength };
  });
  return {
    object,
    fires,
    update(_delta, camera) {
      if (!camera || disposed) return;
      camera.getWorldPosition(cameraPosition);
      for (const flame of flames) faceCamera(flame, cameraPosition);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      for (const fire of fires) fire.object.removeFromParent();
      for (const light of lights) light.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
