// Grass, flowers and trees over a large outdoor ground, drawn in a few calls whatever their count.
// Grass and flowers are shaders over 10 m patches around the camera: patches out of view or
// beyond `distance` are skipped, near ones get curved six-segment blades, farther ones one
// segment, and the last stretch shrinks into the ground, whose color takes over (`colors.far`).
// Trees are a few generated models repeated by instancing, each spot culled to the view, with an
// optional low-face copy past `farDistance`. They use the scene's lights, fog and shadows. Every
// shader is a TSL node material, so it draws under WebGPURenderer and its WebGL 2 fallback. The
// blades follow the method of SimonDev's Quick_Grass (github.com/simondevyoutube/Quick_Grass, MIT).
// Trees drawn in code, their shade on the ground and falling leaves are in core/canopy.js.
//
//   const grass = createGrass({ size: 300, heightAt, densityAt, colors: { base, tip, far } });
//   scene.add(grass.object);
//   grass.update(camera, delta, { wind: 1, pushers: [player.position] })   every frame
//
//   const spots = scatter({ size: 300, count: 250, spacing: 6, densityAt, kinds: 2, seed: 7 });
//   const trees = createTrees([{ path: "models/oak.glb", far: "models/oak-far.glb" },
//                              { path: "models/pine.glb" }], spots, { heightAt });
//   scene.add(trees.object);
//   trees.update(camera, delta, { wind: 1 })                     every frame
//   trees.pushOut(player.position, 0.4)                          keeps the player out of trunks
//   physics.fixed(trees.trunks())                                or trunk colliders with physics
//
//   grass.dispose(); trees.dispose();                            in the game's dispose()
//
// heightAt(x, z) is the ground's height in metres (0 when left out); densityAt(x, z) is how much
// grass grows there, 0 (paths, rock, water) to 1. Both are read once, at creation, over the square
// of `size` metres around `center`: create the grass again after the ground changes.
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  attribute,
  abs,
  atan,
  cameraPosition,
  cameraWorldMatrix,
  clamp,
  cos,
  cross,
  distance,
  dot,
  float,
  floatBitsToUint,
  floor,
  fract,
  fwidth,
  instanceIndex,
  int,
  ivec2,
  length,
  mat3,
  materialColor,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  transformNormalToView,
  uint,
  uniform,
  uniformArray,
  uvec2,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  vertexColor,
} from "three/tsl";
import { placeModel } from "./assets.js";
import { withEnvironmentLighting } from "./three/materials.js";

/** The side of a grass patch in metres. */
export const PATCH = 10;
/** The most pushers (characters, vehicles) that part the grass at once. */
const MAX_PUSHERS = 4;

/** A PCG hash of an unsigned integer. */
const pcg = Fn(([v]) => {
  const s = v.mul(uint(747796405)).add(uint(2891336453));
  const w = s
    .shiftRight(s.shiftRight(uint(28)).add(uint(4)))
    .bitXor(s)
    .mul(uint(277803737));
  return w.shiftRight(uint(22)).bitXor(w);
}).setLayout({ name: "vegPcg", type: "uint", inputs: [{ name: "v", type: "uint" }] });

/** A hash as a number in [0, 1). */
const unit = Fn(([h]) => float(h.shiftRight(uint(8))).div(16777216)).setLayout({
  name: "vegUnit",
  type: "float",
  inputs: [{ name: "h", type: "uint" }],
});

/** Four numbers in [0, 1) from the exact bits of a point. */
const hash4 = Fn(([p]) => {
  const q = floatBitsToUint(p).toVar();
  const a = pcg(q.x.bitXor(pcg(q.y.add(uint(0x9e3779b9))))).toVar();
  const b = pcg(a).toVar();
  const c = pcg(b).toVar();
  const d = pcg(c);
  return vec4(unit(a), unit(b), unit(c), unit(d));
}).setLayout({ name: "vegHash4", type: "vec4", inputs: [{ name: "p", type: "vec2" }] });

/** A hash of a whole-number cell, as a number in [0, 1). */
const hashCell = Fn(([i]) => {
  const q = uvec2(i).toVar();
  return unit(pcg(q.x.bitXor(pcg(q.y))));
}).setLayout({ name: "vegHashCell", type: "float", inputs: [{ name: "i", type: "ivec2" }] });

/** Value noise in [-1, 1]. */
const noise = Fn(([p]) => {
  const i = ivec2(floor(p)).toVar();
  const f = fract(p).toVar();
  const w = f.mul(f).mul(f.mul(-2).add(3)).toVar();
  const a = hashCell(i);
  const b = hashCell(i.add(ivec2(1, 0)));
  const c = hashCell(i.add(ivec2(0, 1)));
  const d = hashCell(i.add(ivec2(1, 1)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y)
    .mul(2)
    .sub(1);
}).setLayout({ name: "vegNoise", type: "float", inputs: [{ name: "p", type: "vec2" }] });

/** Hashes and value noise the vegetation shaders share, as TSL functions. */
export const NOISE = Object.freeze({ pcg, unit, hash4, noise });

/**
 * The ground as the shaders read it, over the maps `createGrass` bakes: `ground(xz)` is the height
 * and grass density at a ground point (vec2) and `shade(xz)` the share of light tree crowns leave
 * there, 1 in the open. `map` (a texture) and `area` (a uniform: min x, min z, size, resolution)
 * are the baked ground; `shadeMap` (a texture) and `shadeArea` (a uniform: min x, min z, size,
 * strength, 0 for no shade) the crowns' shade, which a shader that only reads the ground leaves out.
 */
export function GROUND({ map, area, shadeMap, shadeArea }) {
  // Read by exact texel, without the texture's uv transform, and filtered by hand: the map holds
  // exact floats, which a GPU need not filter.
  const groundMap = texture(map, vec2(0));
  const ground = Fn(([xz]) => {
    const t = xz.sub(area.xy).div(area.z).mul(area.w).sub(0.5).toVar();
    const i = ivec2(floor(t)).toVar();
    const f = t.sub(floor(t)).toVar();
    const last = ivec2(int(area.w).sub(1)).toVar();
    const at = (dx, dy) =>
      textureLoad(groundMap, clamp(i.add(ivec2(dx, dy)), ivec2(0), last), int(0)).rg;
    return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
  });
  const shadeTexture = shadeMap && texture(shadeMap, vec2(0));
  const shade = Fn(([xz]) =>
    float(1).sub(
      texture(shadeTexture, xz.sub(shadeArea.xy).div(shadeArea.z)).level(0).r.mul(shadeArea.w),
    ),
  );
  return { ground, shade };
}

/**
 * The turn by `angle` about the unit `axis`, as a matrix: the other way round from the right-hand
 * rule, as the blades were first tuned.
 */
function turnAbout(axis, angle) {
  const s = sin(angle);
  const c = cos(angle);
  const oc = float(1).sub(c);
  return mat3(
    vec3(
      oc.mul(axis.x).mul(axis.x).add(c),
      oc.mul(axis.x).mul(axis.y).sub(axis.z.mul(s)),
      oc.mul(axis.z).mul(axis.x).add(axis.y.mul(s)),
    ),
    vec3(
      oc.mul(axis.x).mul(axis.y).add(axis.z.mul(s)),
      oc.mul(axis.y).mul(axis.y).add(c),
      oc.mul(axis.y).mul(axis.z).sub(axis.x.mul(s)),
    ),
    vec3(
      oc.mul(axis.z).mul(axis.x).sub(axis.y.mul(s)),
      oc.mul(axis.y).mul(axis.z).add(axis.x.mul(s)),
      oc.mul(axis.z).mul(axis.z).add(c),
    ),
  );
}
const X_AXIS = vec3(1, 0, 0);
const Y_AXIS = vec3(0, 1, 0);

/**
 * How far wind bends a stem at this root and about which axis, and how hard it blows there
 * (`gust`, 0.25 to 1). `wind` is (strength, time).
 */
function windLean(root, wind) {
  const direction = noise(root.mul(0.05).add(wind.y.mul(0.05)));
  const gust = mix(0.25, 1, noise(root.mul(0.25).add(wind.y)).mul(0.5).add(0.5)).toVar();
  return {
    lean: gust.mul(gust).mul(1.25).mul(wind.x),
    axis: vec3(cos(direction), 0, sin(direction)),
    gust,
  };
}

/** How far the nearest of `pushers` (centre, radius; 0 for none) bends a stem, and about what. */
function pushLean(root, pushers) {
  const strongest = float(0).toVar();
  const axis = vec3(1, 0, 0).toVar();
  for (let i = 0; i < MAX_PUSHERS; i += 1) {
    const pusher = pushers.element(i);
    If(pusher.w.greaterThan(0), () => {
      const away = pusher.xz.sub(root.xz).toVar();
      const push = float(1)
        .sub(smoothstep(pusher.w.mul(0.8), pusher.w.mul(2.6), length(away)))
        .mul(float(1).sub(smoothstep(pusher.w.mul(2), pusher.w.mul(4), abs(pusher.y.sub(root.y)))))
        .toVar();
      If(push.greaterThan(strongest), () => {
        strongest.assign(push);
        const g = normalize(away.add(vec2(1e-4, 0)));
        axis.assign(vec3(g.y, 0, g.x.negate()));
      });
    });
  }
  return { lean: strongest, axis };
}

/** A grass blade from its instance: where its vertex is, how it is lit and colored. */
function bladeBody(u) {
  return (patch, index) => {
    const h = pcg(index.mul(uint(2)).add(uint(1))).toVar();
    const offset = vec2(unit(h), unit(pcg(h)))
      .sub(0.5)
      .mul(PATCH);
    const xz = patch.add(offset).toVar();
    const ground = u.ground(xz).toVar();
    const root = vec3(xz.x, ground.x, xz.y).toVar();
    const r = hash4(xz).toVar();
    const tint = hash4(xz.yx.add(17)).toVar();

    const dist = distance(cameraPosition.xz, xz);
    const detailOut = smoothstep(u.blade.z.mul(0.5), u.blade.z, dist).toVar();
    const fadeOut = smoothstep(u.blade.z, u.blade.w, dist).toVar();
    const grows = step(float(1).sub(ground.y), r.w.mul(0.999));
    const height = u.blade.y
      .mul(mix(0.75, 1.5, r.z))
      .mul(float(1).sub(fadeOut))
      .mul(grows)
      .toVar();
    const lean = mix(0.1, 0.4, r.w).add(
      noise(vec2(u.wind.y.mul(0.35)).add(xz.mul(137.423))).mul(0.1),
    );

    const side = positionGeometry.x;
    const along = positionGeometry.y;
    const width = u.blade.x
      .mul(mix(float(1).sub(along.mul(along)), float(1).sub(along), detailOut))
      .toVar();

    const wind = windLean(xz, u.wind);
    const windBend = wind.lean.mul(along).toVar();
    const push = pushLean(root, u.pushers);
    const pushBend = push.lean
      .mul(1.1)
      .mul(mix(0.5, 1, clamp(float(1).sub(windBend.mul(2)), 0, 1)));
    const curve = lean.negate().mul(mix(along.mul(along), 1, detailOut));
    const turn = turnAbout(push.axis, pushBend)
      .mul(turnAbout(wind.axis, windBend))
      .mul(turnAbout(Y_AXIS, r.x.mul(6.2831853)))
      .toVar();
    const bend = turnAbout(X_AXIS, curve).toVar();

    // One-sided blades: a blade whose front looks away from the camera is mirrored, so its front,
    // and its counter-clockwise winding, face the camera.
    const toCamera = cameraPosition.sub(root).mul(vec3(1, 0, 1));
    const facing = dot(turn.mul(vec3(0, 0, 1)), normalize(toCamera.add(vec3(1e-4, 0, 0)))).toVar();
    const flip = select(facing.greaterThanEqual(0), float(1), float(-1)).toVar();
    // Seen edge-on a blade is widened on screen rather than vanishing.
    const edgeOn = abs(facing);
    const thicken = float(1)
      .sub(pow(edgeOn, 4))
      .mul(smoothstep(0, 0.2, edgeOn))
      .mul(side.sub(0.5))
      .mul(width)
      .mul(0.5);

    const position = turn
      .mul(bend.mul(vec3(side.sub(0.5).mul(width).mul(flip), along.mul(height), 0)))
      .add(root)
      .toVar();
    // Mostly-up normals light the field like one soft surface; near blades keep some roundness.
    const bladeNormal = turn.mul(
      bend.mul(normalize(vec3(side.sub(0.5).mul(1.6).mul(flip), 0, flip))),
    );
    const normal = normalize(mix(vec3(0, 1, 0), bladeNormal, float(1).sub(detailOut).mul(0.25)));

    const base = u.base.mul(mix(0.85, 1.15, tint.x)).toVar();
    const tip = u.tip.mul(mix(0.85, 1.15, tint.y)).toVar();
    const color = mix(
      mix(base, tip, pow(along, 4)).mul(mix(0.75, 1, r.y)),
      mix(base, tip, along),
      detailOut,
    ).toVar();
    // Tips brighten in bands where the wind blows hardest, and blades glow with the sun behind them.
    const gust = smoothstep(0.7, 1, wind.gust).mul(min(u.wind.x, 1)).mul(along).mul(along);
    const backlit = clamp(
      dot(normalize(cameraPosition.sub(position)), u.sun.negate())
        .add(0.5)
        .div(1.5),
      0,
      1,
    )
      .mul(dot(u.sun, u.sun))
      .mul(along);
    color.assign(color.mul(backlit.mul(u.glow.y).add(1)).add(tip.mul(gust).mul(u.glow.x)));
    color.assign(mix(color, u.far, smoothstep(0.3, 0.9, fadeOut)));
    // Dark roots, fading with distance so far blades do not become dark specks.
    const shaded = color
      .mul(mix(mix(0.3, 1, along.mul(along)), 1, smoothstep(0, 0.6, fadeOut)))
      .mul(u.shade(xz));
    return { position, normal, color: shaded, thicken };
  };
}

/** A flower (a stem, and a petal head facing up and partly the camera) from its instance. */
function flowerBody(u, petal) {
  return (patch, index) => {
    const k = float(index);
    const r = hash4(vec2(patch.x.add(k.mul(0.618)), patch.y.sub(k.mul(1.37)))).toVar();
    const xz = patch.add(r.xy.sub(0.5).mul(PATCH)).toVar();
    const ground = u.ground(xz).toVar();
    const root = vec3(xz.x, ground.x, xz.y).toVar();

    // Flowers grow in drifts, and a slower noise keeps most of a drift one color.
    const drift = noise(xz.mul(0.045).add(11)).mul(0.5).add(0.5);
    const grows = step(r.z, smoothstep(0.42, 0.78, drift).mul(u.flower.y))
      .mul(step(0.6, ground.y))
      .toVar();
    const kind = noise(xz.mul(0.018).sub(4)).mul(0.5).add(0.5).add(r.w.sub(0.5).mul(0.25));
    const colour = int(clamp(kind.mul(u.flower.w), 0, u.flower.w.sub(0.01))).toVar();
    const dist = distance(cameraPosition.xz, xz);
    const fade = float(1)
      .sub(smoothstep(u.flower.z.mul(0.6), u.flower.z, dist))
      .toVar();
    const height = mix(0.75, 1.15, fract(r.w.mul(13.7)))
      .mul(u.blade.y)
      .mul(grows)
      .mul(fade);
    const size = mix(0.8, 1.2, fract(r.z.mul(7.1)))
      .mul(u.flower.x)
      .mul(grows)
      .mul(fade);

    const wind = windLean(xz, u.wind);
    const windBend = wind.lean.mul(0.7).toVar();
    const push = pushLean(root, u.pushers);
    const position = vec3(0).toVar();
    const color = vec3(0).toVar();
    const thicken = float(0).toVar();
    If(positionGeometry.z.lessThan(0.5), () => {
      const along = positionGeometry.y;
      const turn = turnAbout(push.axis, push.lean).mul(turnAbout(wind.axis, windBend.mul(along)));
      position.assign(root.add(turn.mul(vec3(0, along.mul(height), 0))));
      thicken.assign(positionGeometry.x.sub(0.5).mul(0.022).mul(grows).mul(fade));
      color.assign(u.stem.mul(mix(0.4, 1, along)));
      petal.assign(vec3(0));
    }).Else(() => {
      // The head faces up, turned partly toward the camera, at a random spin.
      const turn = turnAbout(push.axis, push.lean).mul(turnAbout(wind.axis, windBend)).toVar();
      const top = root.add(turn.mul(vec3(0, height, 0)));
      const up = normalize(
        mix(turn.mul(vec3(0, 1, 0)), normalize(cameraPosition.sub(root)), 0.4),
      ).toVar();
      const across = normalize(
        cross(up, select(abs(up.z).greaterThan(0.9), vec3(1, 0, 0), vec3(0, 0, 1))),
      ).toVar();
      const other = cross(up, across);
      const spin = r.x.mul(40).toVar();
      const corner = positionGeometry.xy;
      const turned = vec2(
        corner.x.mul(cos(spin)).sub(corner.y.mul(sin(spin))),
        corner.x.mul(sin(spin)).add(corner.y.mul(cos(spin))),
      );
      position.assign(top.add(across.mul(turned.x).add(other.mul(turned.y)).mul(size)));
      color.assign(u.petals.element(colour));
      petal.assign(vec3(corner, float(colour.mod(2)).add(1)));
    });
    return { position, normal: vec3(0, 1, 0), color: color.mul(u.shade(xz)), thicken };
  };
}

/**
 * A petal head's outline and centre from its corner: five or six petals by color. Blended rather
 * than branched, so the outline's screen-space derivative is taken in uniform control flow.
 */
function flowerShape(u, petal, color) {
  const r = length(petal.xy).toVar();
  const petals = mix(5, 6, step(1.5, petal.z));
  const d = float(0.55)
    .add(pow(abs(cos(atan(petal.y, petal.x).mul(petals).mul(0.5))), 0.7).mul(0.42))
    .sub(r)
    .toVar();
  const shape = clamp(d.div(max(fwidth(d), 1e-4)).add(0.5), 0, 1);
  const head = step(0.5, petal.z).toVar();
  const tinted = mix(
    u.centre,
    color.mul(smoothstep(0.15, 0.85, r).mul(0.3).add(0.7)),
    smoothstep(0.2, 0.27, r),
  );
  return { color: mix(color, tinted, head), alpha: mix(1, shape, head) };
}

/** Foliage uses the shared sky environment; a fixed level's probe grid must not add it twice. */
export class FoliageMaterial extends withEnvironmentLighting(THREE.MeshStandardNodeMaterial) {
  constructor(options = {}) {
    super({ roughness: 1, metalness: 0, ...options });
  }
}

/**
 * A rough PBR node material whose vertex stage builds each blade or flower from its instance: the
 * `perPatch` instances of a patch read its centre from a uniform array the CPU fills each frame.
 * `body(patch, index)` gives the vertex's position, normal, color and how far it widens on screen;
 * `shape(color)` cuts a fragment's outline. A cut-out shape's edge is smoothed where the canvas is
 * antialiased (alpha to coverage) and cut elsewhere. Returns the material and its centres (two to
 * an entry: x, z, x, z).
 */
function fieldMaterial({ perPatch, capacity, body, shape, alphaTest = 0 }) {
  const centres = Array.from({ length: Math.ceil(capacity / 2) }, () => new THREE.Vector4());
  const patches = uniformArray(centres, "vec4");
  const color = varyingProperty("vec3", "vegColor");
  const normal = varyingProperty("vec3", "vegNormal");
  const material = new FoliageMaterial({
    alphaTest,
    alphaToCoverage: alphaTest > 0,
  });
  material.positionNode = Fn(() => {
    const patch = instanceIndex.div(uint(perPatch)).toVar();
    const pair = patches.element(patch.shiftRight(uint(1))).toVar();
    const centre = select(patch.bitAnd(uint(1)).equal(uint(0)), pair.xy, pair.zw);
    const built = body(centre, instanceIndex.mod(uint(perPatch)));
    color.assign(built.color);
    normal.assign(built.normal);
    // Widened across the view: the camera's right, as in view space.
    return built.position.add(cameraWorldMatrix.element(0).xyz.mul(built.thicken));
  })();
  material.normalNode = normalize(transformNormalToView(normal));
  const shaped = shape ? shape(color) : { color, alpha: undefined };
  material.colorNode = vec4(shaped.color, 1);
  if (shaped.alpha) {
    material.opacityNode = shaped.alpha;
  }
  return { material, centres };
}

/** Indices of a strip of `rows` vertex pairs (left, right), counter-clockwise seen from +z. */
function strip(rows, first = 0) {
  const indices = [];
  for (let row = 0; row < rows - 1; row += 1) {
    const v = first + row * 2;
    indices.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
  }
  return indices;
}

/**
 * Gives a geometry whose shader works out its own normal an upward `normal` attribute: three.js
 * expects one on every lit mesh and warns at each build of one without it.
 */
export function shaped(geometry) {
  const normals = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 1; i < normals.length; i += 3) {
    normals[i] = 1;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geometry;
}

/** A blade of `segments` segments: x is the side (0, 1), y the share of its height. */
function bladeGeometry(segments) {
  const positions = [];
  for (let row = 0; row <= segments; row += 1) {
    positions.push(0, row / segments, 0, 1, row / segments, 0);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(strip(segments + 1));
  return shaped(geometry);
}

/** A stem of two segments (z = 0) and a head quad (z = 1, x and y its corner). */
function flowerGeometry() {
  const positions = [0, 0, 0, 1, 0, 0, 0, 0.5, 0, 1, 0.5, 0, 0, 1, 0, 1, 1, 0];
  positions.push(-1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([...strip(3), 6, 7, 8, 8, 7, 9]);
  return shaped(geometry);
}

/**
 * Samples `heightAt` and `densityAt` over the area once, as the map the shaders read and a copy
 * for culling. `resolution` texels a side, at most 512.
 */
function bakeGround({ size, center, heightAt, densityAt, resolution }) {
  const data = new Float32Array(resolution * resolution * 2);
  const min = { x: center.x - size / 2, z: center.z - size / 2 };
  for (let iz = 0; iz < resolution; iz += 1) {
    const z = min.z + ((iz + 0.5) / resolution) * size;
    for (let ix = 0; ix < resolution; ix += 1) {
      const x = min.x + ((ix + 0.5) / resolution) * size;
      const i = (iz * resolution + ix) * 2;
      data[i] = heightAt(x, z);
      data[i + 1] = THREE.MathUtils.clamp(densityAt(x, z), 0, 1);
    }
  }
  const map = new THREE.DataTexture(data, resolution, resolution, THREE.RGFormat, THREE.FloatType);
  map.needsUpdate = true;
  /** Height (channel 0) or density (1) at a point, bilinear like the shader. */
  const sample = (x, z, channel) => {
    const tx = THREE.MathUtils.clamp(((x - min.x) / size) * resolution - 0.5, 0, resolution - 1);
    const tz = THREE.MathUtils.clamp(((z - min.z) / size) * resolution - 0.5, 0, resolution - 1);
    const ix = Math.min(Math.floor(tx), resolution - 2);
    const iz = Math.min(Math.floor(tz), resolution - 2);
    const fx = tx - ix;
    const fz = tz - iz;
    const at = (dx, dz) => data[((iz + dz) * resolution + ix + dx) * 2 + channel];
    const near = at(0, 0) + (at(1, 0) - at(0, 0)) * fx;
    const far = at(0, 1) + (at(1, 1) - at(0, 1)) * fx;
    return near + (far - near) * fz;
  };
  return { map, min, sample };
}

/**
 * One instanced field (blades or flowers) whose instances follow a list of patch centres, which
 * `options` (see `fieldMaterial`) turn into its material.
 */
function field(geometry, options) {
  const { perPatch, capacity } = options;
  const { material, centres } = fieldMaterial(options);
  geometry.instanceCount = 0;
  const mesh = new THREE.Mesh(geometry, material);
  // Patches are culled here, by the camera; the mesh's own bounds would be one blade's.
  mesh.frustumCulled = false;
  // The patch centres the shader reads, two to an entry (x, z, x, z).
  mesh.userData.patches = centres;
  return {
    mesh,
    /** Draws `perPatch` instances at each of `list` ([x, z] pairs). */
    show(list) {
      const count = Math.min(list.length, capacity);
      for (let i = 0; i < count; i += 1) {
        const pair = centres[i >> 1];
        if (i % 2 === 0) {
          pair.x = list[i][0];
          pair.y = list[i][1];
        } else {
          pair.z = list[i][0];
          pair.w = list[i][1];
        }
      }
      geometry.instanceCount = count * perPatch;
    },
  };
}

/**
 * Grass, with optional flowers in drifts, over the square of `size` metres around `center`.
 * `bladesPerPatch` blades grow on each 10 m patch where `densityAt` allows. Returns
 * { object, update(camera, delta, { wind, pushers }), stats, dispose() }; `pushers` are up to four
 * positions (Vector3) whose grass parts around them, `pushRadius` metres wide. `gusts` brightens
 * the tips where the wind blows hardest and `backlight` the blades seen against the sun (0 turns
 * either off); the sun is the scene's first directional light unless `sun` names one. `shade` is
 * the shade of tree crowns (`trees.shade` of core/canopy.js), which darkens grass, flowers and the
 * painted ground under them.
 */
export function createGrass({
  size,
  center = { x: 0, z: 0 },
  heightAt = () => 0,
  densityAt = () => 1,
  resolution = Math.min(512, Math.ceil(size)),
  bladesPerPatch = 2048,
  bladeHeight = 0.6,
  bladeWidth = 0.08,
  distance = 80,
  detailDistance = 15,
  colors = {},
  flowers = {},
  pushRadius = 0.5,
  shadows = true,
  gusts = 0.35,
  backlight = 0.5,
  sun,
  shade,
} = {}) {
  const ground = bakeGround({ size, center, heightAt, densityAt, resolution });
  const time = { value: 0 };
  // Without tree shade the shaders read one texel of none.
  const open = shade ? undefined : new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat);
  if (open) {
    open.needsUpdate = true;
  }
  const area = new THREE.Vector4(ground.min.x, ground.min.z, size, resolution);
  /** The uniforms every grass shader reads, and the ground and shade over them. */
  const u = {
    ...GROUND({
      map: ground.map,
      area: uniform(area),
      shadeMap: shade?.map ?? open,
      shadeArea: uniform(shade?.area ?? new THREE.Vector4(0, 0, 1, 0)).setName("vegShadeArea"),
    }),
    blade: uniform(new THREE.Vector4(bladeWidth, bladeHeight, detailDistance, distance)),
    wind: uniform(new THREE.Vector2(1, 0)).setName("vegWind"),
    pushers: uniformArray(
      Array.from({ length: MAX_PUSHERS }, () => new THREE.Vector4()),
      "vec4",
    ),
    base: uniform(new THREE.Color(colors.base ?? "#2a5319")),
    tip: uniform(new THREE.Color(colors.tip ?? "#d3e789")),
    far: uniform(new THREE.Color(colors.far ?? "#95ad5d")),
    sun: uniform(new THREE.Vector3()).setName("vegSun"),
    glow: uniform(new THREE.Vector2(gusts, backlight)).setName("vegGlow"),
  };
  const reach = Math.ceil(distance / PATCH) + 1;
  const capacity = (reach * 2 + 1) ** 2;
  const object = new THREE.Group();
  object.name = "grass";

  // Near and far blades are built alike, each from its own list of patches.
  const blades = { perPatch: bladesPerPatch, capacity, body: bladeBody(u) };
  const near = field(bladeGeometry(6), blades);
  const far = field(bladeGeometry(1), blades);
  const fields = [near, far];

  const petals = (
    flowers.colors ?? ["#f4f1e6", "#ffc61a", "#ff6b9e", "#9b59ff", "#5b8cff", "#ff5a1f"]
  )
    .slice(0, 6)
    .map((color) => new THREE.Color(color));
  const flowerDistance = Math.min(flowers.distance ?? 50, distance);
  let bloom;
  if ((flowers.perPatch ?? 0) > 0) {
    const bloomUniforms = {
      ...u,
      flower: uniform(
        new THREE.Vector4(flowers.size ?? 0.13, flowers.amount ?? 1, flowerDistance, petals.length),
      ),
      petals: uniformArray([...petals, ...Array(6 - petals.length).fill(petals[0])], "color"),
      stem: uniform(new THREE.Color(flowers.stem ?? "#2f5a12")),
      centre: uniform(new THREE.Color(flowers.centre ?? "#ffbf1f")),
    };
    // The head's corner and whether it has six petals (2) or five (1); 0 on the stem.
    const petal = varyingProperty("vec3", "vegPetal");
    bloom = field(flowerGeometry(), {
      perPatch: flowers.perPatch,
      capacity,
      body: flowerBody(bloomUniforms, petal),
      shape: (color) => flowerShape(bloomUniforms, petal, color),
      alphaTest: 0.5,
    });
    fields.push(bloom);
  }
  for (const { mesh } of fields) {
    mesh.receiveShadow = shadows;
    object.add(mesh);
  }

  /** Each patch's height range and whether anything grows on it, worked out once. */
  const patchInfo = new Map();
  const infoAt = (x, z) => {
    const key = `${x},${z}`;
    let info = patchInfo.get(key);
    if (!info) {
      let low = Infinity;
      let high = -Infinity;
      let grows = 0;
      for (let a = -2; a <= 2; a += 1) {
        for (let b = -2; b <= 2; b += 1) {
          const px = x + (a * PATCH) / 4;
          const pz = z + (b * PATCH) / 4;
          const height = ground.sample(px, pz, 0);
          low = Math.min(low, height);
          high = Math.max(high, height);
          grows = Math.max(grows, ground.sample(px, pz, 1));
        }
      }
      info = { low, high, grows: grows > 0.01 };
      patchInfo.set(key, info);
    }
    return info;
  };

  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const box = new THREE.Box3();
  const eye = new THREE.Vector3();
  const half = size / 2 - PATCH / 2;
  const top = bladeHeight * 1.5 + 1;
  const stats = { near: 0, far: 0, flowers: 0, blades: 0 };
  const towardSun = sunTracker(object, sun);

  return {
    object,
    stats,
    /** The baked ground, for what else stands on it (the falling leaves of core/canopy.js). */
    ground: { map: ground.map, area },
    /** Picks the patches in view, near and far, and moves the wind and the pushers. */
    update(camera, delta, { wind = 1, pushers = [] } = {}) {
      time.value += delta;
      u.wind.value.set(wind, time.value);
      towardSun(delta, u.sun.value);
      u.pushers.array.forEach((slot, i) => {
        const pusher = pushers[i];
        slot.set(pusher?.x ?? 0, pusher?.y ?? 0, pusher?.z ?? 0, pusher ? pushRadius : 0);
      });

      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      camera.getWorldPosition(eye);
      const baseX = Math.floor(eye.x / PATCH) * PATCH;
      const baseZ = Math.floor(eye.z / PATCH) * PATCH;
      const lists = { near: [], far: [], flowers: [] };
      for (let i = -reach; i <= reach; i += 1) {
        for (let j = -reach; j <= reach; j += 1) {
          const x = baseX + i * PATCH;
          const z = baseZ + j * PATCH;
          if (Math.abs(x - center.x) > half || Math.abs(z - center.z) > half) {
            continue;
          }
          const dx = Math.max(Math.abs(eye.x - x) - PATCH / 2, 0);
          const dz = Math.max(Math.abs(eye.z - z) - PATCH / 2, 0);
          const away = Math.hypot(dx, dz);
          if (away > distance) {
            continue;
          }
          const info = infoAt(x, z);
          if (!info.grows) {
            continue;
          }
          box.min.set(x - PATCH / 2, info.low - 1, z - PATCH / 2);
          box.max.set(x + PATCH / 2, info.high + top, z + PATCH / 2);
          if (!frustum.intersectsBox(box)) {
            continue;
          }
          const entry = [x, z, away];
          (away > detailDistance ? lists.far : lists.near).push(entry);
          if (away <= flowerDistance) {
            lists.flowers.push(entry);
          }
        }
      }
      // Nearest first, so near blades hide what is behind them before it is shaded.
      for (const list of Object.values(lists)) {
        list.sort((a, b) => a[2] - b[2]);
      }
      near.show(lists.near);
      far.show(lists.far);
      bloom?.show(lists.flowers);
      stats.near = lists.near.length;
      stats.far = lists.far.length;
      stats.flowers = bloom ? lists.flowers.length : 0;
      stats.blades = (stats.near + stats.far) * bladesPerPatch;
    },
    /** The ground's height as the grass sees it. */
    heightAt: (x, z) => ground.sample(x, z, 0),
    /**
     * Colors the ground under the grass like the field: its roots' color near the camera,
     * turning to `colors.far` where the blades shrink away, so the field has no edge. Bare ground
     * keeps the material's own color, and all of it darkens under `shade`. Changes `material`
     * (the ground's) in place.
     */
    paintGround(material) {
      // A built-in material that three.js turns into a node material when it draws it carries
      // its colorNode over, so the ground may be either kind.
      let painted = material.colorNode ?? materialColor;
      if (material.vertexColors) {
        // Vertex colors tint the ground's own color only, not the grass color painted over it.
        painted = painted.mul(vertexColor());
        material.vertexColors = false;
      }
      const distant = smoothstep(
        u.blade.z,
        u.blade.w,
        length(cameraPosition.xz.sub(positionWorld.xz)),
      );
      const grows = smoothstep(0.15, 0.7, u.ground(positionWorld.xz).y);
      material.colorNode = vec4(
        mix(painted.rgb, mix(u.base, u.far, distant), grows).mul(u.shade(positionWorld.xz)),
        painted.a,
      );
      material.needsUpdate = true;
    },
    dispose() {
      object.removeFromParent();
      for (const { mesh } of fields) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      ground.map.dispose();
      open?.dispose();
    },
  };
}

/**
 * Where the sun is, for the shading the scene's lights do not do. Returns a function that, each
 * frame, writes the direction toward the sun into `target` and returns it: `sun`'s when one is
 * given, else that of the first sun or directional light of the scene, looked for once a
 * second while there is none. Without a light `target` is zero.
 */
export function sunTracker(object, sun) {
  let light = sun;
  let wait = 0;
  const aim = new THREE.Vector3();
  return (delta, target) => {
    if (!sun && !light?.parent) {
      light = undefined;
      wait -= delta;
      if (wait <= 0) {
        wait = 1;
        let root = object;
        while (root.parent) {
          root = root.parent;
        }
        root.traverse((child) => {
          light ??=
            (child.isDirectionalLight || child.isSunLight) && child.visible && child.intensity > 0
              ? child
              : undefined;
        });
      }
    }
    if (!light || !light.visible || light.intensity <= 0) {
      return target.set(0, 0, 0);
    }
    light.getWorldPosition(target);
    if (light.isSunLight) {
      return target.normalize();
    }
    light.target.getWorldPosition(aim);
    return target.sub(aim).normalize();
  };
}

/** A small seeded random number generator (mulberry32): the same seed, the same sequence. */
export function random(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1]. */
export function valueNoise(x, z) {
  const cell = (a, b) => {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = cell(ix, iz);
  const b = cell(ix + 1, iz);
  const c = cell(ix, iz + 1);
  const d = cell(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * Up to `count` spots in the square of `size` metres around `center`, at least `spacing` metres
 * apart, only where `densityAt` is 0.5 or more. `groves` (metres) gathers them into groves of
 * about that size (0 spreads them evenly); with `kinds` models, a region mostly holds one kind.
 * The same seed gives the same spots, so a new version of the game keeps its forest.
 * Each spot is { x, z, rotation, scale, kind }.
 */
export function scatter({
  size,
  center = { x: 0, z: 0 },
  count,
  spacing = 5,
  densityAt = () => 1,
  groves = 60,
  kinds = 1,
  scale = [0.8, 1.25],
  seed = 1,
}) {
  const next = random(seed * 7919 + 1);
  const spots = [];
  const cells = new Map();
  const key = (x, z) => `${Math.floor(x / spacing)},${Math.floor(z / spacing)}`;
  for (let tries = 0; tries < count * 40 && spots.length < count; tries += 1) {
    const x = center.x + (next() - 0.5) * size;
    const z = center.z + (next() - 0.5) * size;
    if (densityAt(x, z) < 0.5) {
      continue;
    }
    if (groves > 0) {
      const grove = valueNoise(x / groves + seed, z / groves - seed);
      if (next() > THREE.MathUtils.clamp((grove - 0.42) * 3, 0.04, 1)) {
        continue;
      }
    }
    const cx = Math.floor(x / spacing);
    const cz = Math.floor(z / spacing);
    let crowded = false;
    for (let i = -1; i <= 1 && !crowded; i += 1) {
      for (let j = -1; j <= 1 && !crowded; j += 1) {
        crowded = (cells.get(`${cx + i},${cz + j}`) ?? []).some(
          (other) => Math.hypot(other.x - x, other.z - z) < spacing,
        );
      }
    }
    if (crowded) {
      continue;
    }
    const region = valueNoise(x / 110 - 3.7 * seed, z / 110 + 9.1);
    const kind = THREE.MathUtils.clamp(
      Math.floor(region * kinds + (next() - 0.5) * 1.6),
      0,
      kinds - 1,
    );
    const spot = {
      x,
      z,
      rotation: next() * Math.PI * 2,
      scale: scale[0] + next() * (scale[1] - scale[0]),
      kind,
    };
    spots.push(spot);
    cells.set(key(x, z), [...(cells.get(key(x, z)) ?? []), spot]);
  }
  return spots;
}

/**
 * How far the wind moves a point of a tree rooted at `base` (world): `up` is the point's share of
 * the tree's `height` (metres, as it stands) and `wind` is (strength, time). Trunk and crown read
 * the same sway, so they stay together.
 */
export const SWAY = Fn(([base, up, height, wind]) => {
  const seed = fract(sin(dot(base.xz, vec2(12.9898, 78.233))).mul(43758.5453));
  const direction = noise(base.xz.mul(0.05).add(wind.y.mul(0.05)));
  const swing = float(0.5)
    .add(sin(wind.y.mul(1.1).add(seed.mul(6.28))).mul(0.35))
    .add(sin(wind.y.mul(2.7).add(seed.mul(17))).mul(0.15));
  return vec3(cos(direction), up.mul(-0.25), sin(direction)).mul(
    height.mul(0.035).mul(wind.x).mul(swing).mul(up).mul(up),
  );
}).setLayout({
  name: "vegSway",
  type: "vec3",
  inputs: [
    { name: "base", type: "vec3" },
    { name: "up", type: "float" },
    { name: "height", type: "float" },
    { name: "wind", type: "vec2" },
  ],
});

/**
 * Gives an instanced tree mesh the attribute its sway reads: each copy's root (x, y, z, before the
 * mesh's own transform) and scale, written with `setXYZW(index, ...)` beside `setMatrixAt`. The
 * shader cannot read the instance matrix itself, so the copy's root rides beside it.
 */
export function rooted(mesh) {
  const roots = new THREE.InstancedBufferAttribute(
    new Float32Array(mesh.instanceMatrix.count * 4),
    4,
  );
  roots.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute("vegRoot", roots);
  return roots;
}

/** Uploads the first `mesh.count` copies' matrices and roots after a frame's placing. */
export function uploadCopies(mesh) {
  for (const buffer of [mesh.instanceMatrix, mesh.geometry.attributes.vegRoot]) {
    if (buffer) {
      buffer.clearUpdateRanges();
      buffer.addUpdateRange(0, Math.max(mesh.count, 1) * buffer.itemSize);
      buffer.needsUpdate = true;
    }
  }
}

/** A node material copy of `material`, which three.js would otherwise convert when it draws it. */
function nodeCopy(material) {
  if (material.isNodeMaterial) {
    return material.clone();
  }
  const Type =
    THREE[material.type.replace(/Material$/, "NodeMaterial")] ?? THREE.MeshStandardNodeMaterial;
  const copy = new Type();
  // As three.js converts one: every property, which a node material reads by the same names.
  for (const key in material) {
    if (!["uuid", "type", "userData", "_listeners"].includes(key)) {
      copy[key] = material[key];
    }
  }
  return copy;
}

/**
 * Sways a tree material's vertices with the wind, more toward the top (after instancing). The mesh
 * drawing the copy is instanced and `rooted`; `uniforms.vegWind` is the wind, (strength, time), as
 * a uniform node. The scene's shadow maps cast the swaying shape.
 */
export function swaying(material, height, uniforms) {
  const copy = nodeCopy(material);
  // The copy belongs to this forest, not to the loaded file.
  copy.userData = {};
  const root = attribute("vegRoot", "vec4");
  // A `{ value }` holder, as uniforms were before node materials, still drives the wind.
  const wind = uniforms.vegWind.isNode ? uniforms.vegWind : uniform(uniforms.vegWind.value);
  copy.positionNode = positionLocal.add(
    SWAY(root.xyz, clamp(positionGeometry.y.div(height), 0, 1.5), root.w.mul(height), wind),
  );
  return copy;
}

/**
 * Keeps walkers out of trunks. `trees` are { position, scale } and `radiusOf(tree)` a trunk's
 * radius in metres before the tree's scale. Returns the `pushOut` and `trunks` a forest offers.
 */
export function trunkGuard(trees, radiusOf) {
  /** Trees in cells of 8 m. */
  const cells = new Map();
  for (const tree of trees) {
    const key = `${Math.floor(tree.position.x / 8)},${Math.floor(tree.position.z / 8)}`;
    cells.set(key, [...(cells.get(key) ?? []), tree]);
  }
  return {
    /** Moves `position` (in place) out of any trunk within `radius`; returns whether it moved. */
    pushOut(position, radius) {
      let moved = false;
      const cx = Math.floor(position.x / 8);
      const cz = Math.floor(position.z / 8);
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          for (const tree of cells.get(`${cx + i},${cz + j}`) ?? []) {
            const dx = position.x - tree.position.x;
            const dz = position.z - tree.position.z;
            const away = Math.hypot(dx, dz);
            const least = radius + radiusOf(tree) * tree.scale;
            if (away < least && away > 1e-6) {
              position.x = tree.position.x + (dx / away) * least;
              position.z = tree.position.z + (dz / away) * least;
              moved = true;
            }
          }
        }
      }
      return moved;
    },
    /** A trunk cylinder 3 m tall at every spot, for `physics.fixed`; not added to the scene. */
    trunks() {
      const group = new THREE.Group();
      const shapes = new Map();
      for (const tree of trees) {
        const radius = radiusOf(tree);
        if (!shapes.has(radius)) {
          shapes.set(radius, new THREE.CylinderGeometry(radius, radius, 3, 8).translate(0, 1.5, 0));
        }
        const mesh = new THREE.Mesh(shapes.get(radius));
        mesh.position.copy(tree.position);
        mesh.scale.setScalar(tree.scale);
        group.add(mesh);
      }
      return group;
    },
  };
}

/**
 * Repeats generated models at `spots` (from `scatter`, or { x, z, y?, rotation?, scale?, kind? })
 * by instancing: one draw per mesh of each model, whatever the number of trees. `models[kind]` is
 * { path, far? }: `far` is a lower-face copy shown past `farDistance` metres; nothing is drawn past
 * `distance`. A model still being generated shows its placeholder, and a model written again
 * replaces every copy, as does a corrected size or front in public/assets.json. Returns { object, update(camera, delta, { wind }), pushOut(position,
 * radius), trunks(), stats, dispose() }.
 */
export function createTrees(
  models,
  spots,
  { heightAt = () => 0, farDistance = 60, distance = 300, trunk = 0.3, shadows = true } = {},
) {
  const object = new THREE.Group();
  object.name = "trees";
  // Placements live outside the scene: only their instanced copies are drawn.
  const stash = new THREE.Group();
  const wind = { vegWind: uniform(new THREE.Vector2(1, 0)).setName("vegWind") };
  const placed = spots.map((spot) => {
    const position = new THREE.Vector3(spot.x, spot.y ?? heightAt(spot.x, spot.z), spot.z);
    const matrix = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.rotation ?? 0),
      new THREE.Vector3().setScalar(spot.scale ?? 1),
    );
    return { spot, kind: spot.kind ?? 0, position, scale: spot.scale ?? 1, matrix };
  });

  const level = (path, count, castShadow) => {
    const placement = placeModel(path, stash);
    return { path, placement, count, castShadow, shown: undefined, meshes: [], bounds: undefined };
  };
  const kinds = models.map((model, kind) => {
    const count = placed.filter((tree) => tree.kind === kind).length;
    return {
      near: level(model.path, count, shadows),
      far: model.far ? level(model.far, count, false) : undefined,
    };
  });

  const clear = (lod) => {
    for (const mesh of lod.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    lod.meshes = [];
  };
  /**
   * What a level's holder shows and how it is placed: a new file swaps the child, and a corrected
   * manifest entry (size, front) moves, turns or scales the same child in place.
   */
  const showing = (lod) => {
    const shown = lod.placement.holder.children[0];
    return (
      shown &&
      [
        shown.uuid,
        ...shown.position.toArray(),
        ...shown.quaternion.toArray(),
        ...shown.scale.toArray(),
      ].join()
    );
  };
  /** Builds a level's instanced meshes from what its holder shows: the model, or its placeholder. */
  const build = (lod) => {
    clear(lod);
    const shown = lod.placement.holder.children[0];
    lod.shown = showing(lod);
    if (!shown || lod.count === 0) {
      return;
    }
    lod.placement.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(lod.placement.holder);
    const height = Math.max(box.max.y, 0.01);
    lod.bounds = { height, radius: box.getSize(new THREE.Vector3()).length() / 2 };
    lod.placement.holder.traverse((child) => {
      if (!child.isMesh || child.isSkinnedMesh) {
        return;
      }
      const geometry = child.geometry.clone().applyMatrix4(child.matrixWorld);
      geometry.userData = {};
      const material = Array.isArray(child.material)
        ? child.material.map((each) => swaying(each, height, wind))
        : swaying(child.material, height, wind);
      const mesh = new THREE.InstancedMesh(geometry, material, lod.count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      rooted(mesh);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = lod.castShadow;
      mesh.receiveShadow = true;
      object.add(mesh);
      lod.meshes.push(mesh);
    });
  };

  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const eye = new THREE.Vector3();
  const stats = { near: 0, far: 0 };
  let time = 0;

  return {
    object,
    stats,
    /** Culls the trees to the view and splits them into near and far copies. */
    update(camera, delta, { wind: strength = 1 } = {}) {
      time += delta;
      wind.vegWind.value.set(strength, time);
      for (const lods of kinds) {
        for (const lod of [lods.near, lods.far]) {
          if (lod && showing(lod) !== lod.shown) {
            build(lod);
          }
        }
      }
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      camera.getWorldPosition(eye);
      const counts = new Map();
      stats.near = 0;
      stats.far = 0;
      for (const tree of placed) {
        const lods = kinds[tree.kind];
        if (!lods) {
          continue;
        }
        const away = Math.hypot(tree.position.x - eye.x, tree.position.z - eye.z);
        if (away > distance) {
          continue;
        }
        const isFar = Boolean(lods.far) && away > farDistance;
        const lod = isFar ? lods.far : lods.near;
        if (!lod.bounds) {
          continue;
        }
        sphere.center
          .copy(tree.position)
          .setY(tree.position.y + (lod.bounds.height * tree.scale) / 2);
        sphere.radius = lod.bounds.radius * tree.scale;
        if (!frustum.intersectsSphere(sphere)) {
          continue;
        }
        const index = counts.get(lod) ?? 0;
        counts.set(lod, index + 1);
        for (const mesh of lod.meshes) {
          mesh.setMatrixAt(index, tree.matrix);
          mesh.geometry.attributes.vegRoot.setXYZW(index, ...tree.position, tree.scale);
        }
        stats[isFar ? "far" : "near"] += 1;
      }
      for (const lods of kinds) {
        for (const lod of [lods.near, lods.far]) {
          for (const mesh of lod?.meshes ?? []) {
            mesh.count = counts.get(lod) ?? 0;
            uploadCopies(mesh);
          }
        }
      }
    },
    ...trunkGuard(placed, () => trunk),
    dispose() {
      object.removeFromParent();
      for (const lods of kinds) {
        for (const lod of [lods.near, lods.far]) {
          if (lod) {
            clear(lod);
            lod.placement.remove();
          }
        }
      }
    },
  };
}
