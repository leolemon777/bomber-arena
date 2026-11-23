// Trees drawn in code for a stylized world, the shade they leave on the ground and their falling
// leaves. A tree is a trunk with a few branches and a crown of small leaf cards that always face
// the camera; the cards are colored in bands as one soft shape, so a crown reads as a few puffs
// and not as hundreds of leaves. Nothing is generated or loaded: a style is numbers and colors.
// They stand beside core/vegetation.js, which draws the grass and repeats generated tree models.
// After Michael Dougall's "Creating fluffy trees with Three.js" and the Ghibli normal-transfer
// look; the branches follow the recursion of Dan Greenheck's ez-tree (MIT), much lighter.
//
//   const spots = scatter({ size: 280, count: 250, spacing: 6, densityAt, kinds: 2, seed: 7 });
//   const trees = createCanopyTrees(["oak", { style: "maple", colors: [...] }], spots, { heightAt });
//   scene.add(trees.object);
//   const grass = createGrass({ size: 300, heightAt, densityAt, shade: trees.shade });
//   const leaves = createFallingLeaves(trees, { ground: grass.ground });
//   scene.add(leaves.object);
//   trees.update(camera, delta, { wind: 1 }); leaves.update(camera, delta, { wind: 1 })   every frame
//   trees.pushOut(player.position, 0.4)          or physics.fixed(trees.trunks()), as createTrees
//
//   leaves.dispose(); trees.dispose();           in the game's dispose()
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  fwidth,
  instanceIndex,
  length,
  mat3,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalLocal,
  normalize,
  positionGeometry,
  positionLocal,
  pow,
  select,
  sin,
  smoothstep,
  step,
  uint,
  uniform,
  uniformArray,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  FoliageMaterial,
  GROUND,
  NOISE,
  SWAY,
  random,
  rooted,
  shaped,
  sunTracker,
  swaying,
  trunkGuard,
  uploadCopies,
  valueNoise,
} from "./vegetation.js";

/**
 * The styles a tree can take. `height` and `trunk` (its radius) are metres; `stem`, `limb` and
 * `twig` are the lengths of the trunk, its branches and theirs as shares of the height; `from` is
 * how far up the trunk branches start; `spread` is a branch's angle from its parent (radians) and
 * `lift` how much it turns upward; `crown` is the range of a leaf cluster's radius and `squash`
 * its height against its width; `card` scales the leaf cards; `leaf` is their outline (lobed,
 * needle, round); `colors` are the crown's four bands from lit to deep shade and `bark` the trunk.
 * A conifer has `rings` of clusters round a straight trunk instead of branches. `sheds: false`
 * keeps a tree out of the falling leaves and `fall` is how fast its leaves drop (metres a second).
 */
export const CANOPY_STYLES = Object.freeze({
  oak: {
    height: 8,
    trunk: 0.32,
    stem: 0.45,
    from: 0.6,
    limbs: [3, 4],
    limb: 0.3,
    twigs: [2, 3],
    twig: 0.17,
    spread: 0.8,
    lift: 0.25,
    crown: [1.4, 2],
    squash: 0.85,
    colors: ["#b9d568", "#7fae3f", "#4a7d2c", "#2a5122"],
    bark: "#6b5340",
  },
  maple: {
    height: 7.5,
    trunk: 0.3,
    stem: 0.42,
    from: 0.55,
    limbs: [4, 5],
    limb: 0.28,
    twigs: [2, 3],
    twig: 0.15,
    spread: 0.7,
    lift: 0.3,
    crown: [1.5, 2.1],
    squash: 0.9,
    colors: ["#f6c453", "#e8873a", "#c2542a", "#84301f"],
    bark: "#5e4636",
  },
  birch: {
    height: 9,
    trunk: 0.17,
    stem: 0.78,
    from: 0.42,
    limbs: [6, 8],
    limb: 0.15,
    twigs: [0, 0],
    twig: 0,
    spread: 0.6,
    lift: 0.5,
    crown: [0.9, 1.3],
    squash: 1,
    card: 0.85,
    colors: ["#d3e27a", "#a2c552", "#6c9a3a", "#40692d"],
    bark: "#e9e5d9",
    dashes: "#3a3a36",
  },
  cherry: {
    height: 6,
    trunk: 0.26,
    stem: 0.42,
    from: 0.7,
    limbs: [3, 5],
    limb: 0.3,
    twigs: [2, 3],
    twig: 0.18,
    spread: 1,
    lift: 0.22,
    crown: [1.2, 1.7],
    squash: 0.62,
    leaf: "round",
    fall: 0.55,
    colors: ["#fff0f5", "#f9c3d6", "#ea93b4", "#c06a8c"],
    bark: "#4a3530",
  },
  pine: {
    height: 11,
    trunk: 0.28,
    rings: [7, 9],
    squash: 0.45,
    card: 0.8,
    leaf: "needle",
    sheds: false,
    colors: ["#7fa867", "#557f4b", "#34603d", "#1f3f2d"],
    bark: "#5a4332",
  },
});

const LEAVES = ["lobed", "needle", "round"];
/** Where the sun is taken to be in a scene without a directional light. */
const NOON = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
/** The lowest sun the shade is cast for, as its height on the unit sphere (15 degrees). */
const LOWEST_SUN = 0.26;
/** How long a cluster's shade grows along the sun's direction, in its own radius. */
const LONGEST_SHADE = 1.8;
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/** A style by name or `{ style, ...changes }`, with its colors ready for the shaders. */
function resolveStyle(entry) {
  const { style: name = "oak", ...changes } = typeof entry === "string" ? { style: entry } : entry;
  if (!CANOPY_STYLES[name]) {
    throw new Error(`No tree style "${name}": ${Object.keys(CANOPY_STYLES).join(", ")}.`);
  }
  const style = { ...CANOPY_STYLES[name], ...changes };
  if (style.colors.length !== 4 || !LEAVES.includes(style.leaf ?? "lobed")) {
    throw new Error(`A tree style has four colors and a leaf of ${LEAVES.join(", ")}.`);
  }
  return {
    ...style,
    bands: style.colors.map((color) => new THREE.Color(color)),
    leafKind: LEAVES.indexOf(style.leaf ?? "lobed"),
  };
}

/** `direction` turned `tilt` radians away from itself, toward `azimuth` around it. */
function leaning(direction, tilt, azimuth) {
  const side = new THREE.Vector3()
    .crossVectors(direction, Math.abs(direction.y) < 0.99 ? UP : RIGHT)
    .normalize();
  const other = new THREE.Vector3().crossVectors(direction, side);
  return direction
    .clone()
    .multiplyScalar(Math.cos(tilt))
    .addScaledVector(side, Math.cos(azimuth) * Math.sin(tilt))
    .addScaledVector(other, Math.sin(azimuth) * Math.sin(tilt));
}

/**
 * One tree of a style, rooted at the origin: the tubes of its trunk and branches
 * ({ points, radii, sides }) and its leaf clusters ({ centre, radius }). `next` is the random
 * sequence, so a seed gives the same tree.
 */
function growTree(style, next) {
  const tubes = [];
  const clusters = [];
  const between = ([low, high]) => low + next() * (high - low);
  const height = style.height * (0.9 + next() * 0.2);

  if (style.rings) {
    // A conifer: a straight trunk, and rings of flat clusters that shrink into a cone.
    const lean = new THREE.Vector3((next() - 0.5) * 0.3, 0, (next() - 0.5) * 0.3);
    tubes.push({
      points: [new THREE.Vector3(), lean.clone().setY(height * 0.5), lean.clone().setY(height)],
      radii: [style.trunk, style.trunk * 0.55, style.trunk * 0.12],
      sides: 8,
    });
    const rings = Math.round(between(style.rings));
    for (let ring = 0; ring < rings; ring += 1) {
      const share = ring / (rings - 1);
      const reach = height * 0.21 * (1 - 0.82 * share);
      const puffs = Math.max(1, Math.round(5 * (1 - share) + 1));
      const turn = next() * Math.PI * 2;
      for (let puff = 0; puff < puffs; puff += 1) {
        const azimuth = turn + (puff / puffs) * Math.PI * 2;
        const out = puffs === 1 ? 0 : reach * 0.55;
        clusters.push({
          centre: new THREE.Vector3(
            lean.x + Math.cos(azimuth) * out,
            height * (0.24 + 0.7 * share),
            lean.z + Math.sin(azimuth) * out,
          ),
          radius: Math.max(0.5, reach * 0.62),
        });
      }
    }
    clusters.push({ centre: lean.clone().setY(height), radius: 0.5 });
    return { tubes, clusters, height: height + 0.5 };
  }

  /** A point `share` of the way along a tube's centre line, and its radius there. */
  const along = (points, radii, share) => {
    const at = share * (points.length - 1);
    const i = Math.min(Math.floor(at), points.length - 2);
    return [
      points[i].clone().lerp(points[i + 1], at - i),
      radii[i] + (radii[i + 1] - radii[i]) * (at - i),
    ];
  };
  const branch = (start, heading, length, radius, depth) => {
    const steps = depth === 0 ? 4 : 3;
    const points = [start.clone()];
    const radii = [radius];
    const direction = heading.clone();
    const at = start.clone();
    for (let step = 1; step <= steps; step += 1) {
      const wobble = depth === 0 ? 0.12 : 0.45;
      direction.x += (next() - 0.5) * wobble;
      direction.y += (next() - 0.5) * wobble + (depth === 0 ? 0.3 : style.lift);
      direction.z += (next() - 0.5) * wobble;
      direction.normalize();
      at.addScaledVector(direction, length / steps);
      points.push(at.clone());
      radii.push(radius * (1 - 0.6 * (step / steps)));
    }
    tubes.push({ points, radii, sides: [8, 6, 4][depth] });
    // Every branch ends in leaves; the trunk's own top fills the middle of the crown.
    clusters.push({ centre: at.clone(), radius: between(style.crown) * (depth === 1 ? 0.85 : 1) });
    const children = Math.round(
      between(depth === 0 ? style.limbs : depth === 1 ? style.twigs : [0, 0]),
    );
    const turn = next() * Math.PI * 2;
    for (let child = 0; child < children; child += 1) {
      const share =
        depth === 0
          ? style.from + (1 - style.from) * ((child + next() * 0.7) / children)
          : 0.55 + next() * 0.45;
      const [from, girth] = along(points, radii, share);
      const azimuth = turn + ((child + next() * 0.5) / children) * Math.PI * 2;
      branch(
        from,
        leaning(direction, style.spread * (0.8 + next() * 0.4), azimuth),
        height * (depth === 0 ? style.limb : style.twig),
        girth * 0.62,
        depth + 1,
      );
    }
  };
  branch(new THREE.Vector3(), UP, height * style.stem, style.trunk, 0);
  const top = Math.max(...clusters.map(({ centre, radius }) => centre.y + radius * style.squash));
  return { tubes, clusters, height: top };
}

/** The trunk and branches as one geometry, colored like bark and darker under the crown. */
function trunkGeometry(tubes, style, height, next) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const bark = new THREE.Color(style.bark);
  const dashes = style.dashes ? new THREE.Color(style.dashes) : undefined;
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const other = new THREE.Vector3();
  const color = new THREE.Color();
  for (const [tube, { points, radii, sides }] of tubes.entries()) {
    const first = positions.length / 3;
    for (const [row, point] of points.entries()) {
      tangent
        .subVectors(points[Math.min(row + 1, points.length - 1)], points[Math.max(row - 1, 0)])
        .normalize();
      // Each ring keeps the last one's side, turned to the new direction, so a tube never twists.
      if (row === 0) {
        side.crossVectors(tangent, Math.abs(tangent.y) < 0.99 ? UP : RIGHT).normalize();
      } else {
        side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      }
      other.crossVectors(tangent, side);
      // A birch's dark dashes sit on its trunk only.
      const dashed = dashes && tube === 0 && next() < 0.3;
      const shade =
        (0.85 + next() * 0.3) *
        THREE.MathUtils.lerp(1, 0.6, THREE.MathUtils.smoothstep(point.y / height, 0.3, 0.8));
      color.copy(dashed ? dashes : bark).multiplyScalar(shade);
      for (let corner = 0; corner < sides; corner += 1) {
        const angle = (corner / sides) * Math.PI * 2;
        const x = side.x * Math.cos(angle) + other.x * Math.sin(angle);
        const y = side.y * Math.cos(angle) + other.y * Math.sin(angle);
        const z = side.z * Math.cos(angle) + other.z * Math.sin(angle);
        positions.push(
          point.x + x * radii[row],
          point.y + y * radii[row],
          point.z + z * radii[row],
        );
        normals.push(x, y, z);
        colors.push(color.r, color.g, color.b);
      }
    }
    for (let row = 0; row < points.length - 1; row += 1) {
      for (let corner = 0; corner < sides; corner += 1) {
        const a = first + row * sides + corner;
        const b = first + row * sides + ((corner + 1) % sides);
        indices.push(a, b, a + sides, b, b + sides, a + sides);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The crown's leaf cards: four corners sharing the card's centre, which the shader spreads toward
 * the camera. A card's normal points out of its cluster and out of the whole crown, and `out` says
 * how near the crown's edge it is, so the crown shades as one shape with darker hollows. The cards
 * are in random order: any first share of them is a thinner crown of the same outline.
 */
function crownGeometry(clusters, style, height, next) {
  const weight = clusters.reduce((sum, { radius }) => sum + radius ** 3, 0);
  const middle = clusters
    .reduce(
      (sum, { centre, radius }) => sum.addScaledVector(centre, radius ** 3),
      new THREE.Vector3(),
    )
    .divideScalar(weight);
  const reach = Math.max(
    ...clusters.map(({ centre, radius }) => centre.distanceTo(middle) + radius),
  );
  const cards = [];
  const axis = new THREE.Vector3();
  for (const { centre, radius } of clusters) {
    const count = THREE.MathUtils.clamp(Math.round(radius * radius * 13), 10, 90);
    for (let card = 0; card < count; card += 1) {
      const y = next() * 2 - 1;
      const azimuth = next() * Math.PI * 2;
      const flat = Math.sqrt(1 - y * y);
      const depth = 0.35 + 0.65 * Math.cbrt(next());
      const at = new THREE.Vector3(
        centre.x + Math.cos(azimuth) * flat * radius * depth,
        centre.y + y * radius * depth * style.squash,
        centre.z + Math.sin(azimuth) * flat * radius * depth,
      );
      // A conifer shades round its trunk at the card's own height, or it would light like a ball.
      let edge;
      if (style.rings) {
        axis.set(clusters.at(-1).centre.x, at.y, clusters.at(-1).centre.z);
        const share = THREE.MathUtils.clamp((at.y / height - 0.24) / 0.7, 0, 1);
        edge = at.distanceTo(axis) / (height * 0.25 * (1 - 0.82 * share) + 0.5);
      } else {
        axis.copy(middle);
        edge = at.distanceTo(middle) / reach;
      }
      const normal = at
        .clone()
        .sub(centre)
        .normalize()
        .multiplyScalar(0.55)
        .addScaledVector(at.clone().sub(axis).normalize(), 0.45)
        .normalize();
      cards.push({
        at,
        normal,
        size: (0.5 + next() * 0.3) * (style.card ?? 1),
        spin: next(),
        phase: next(),
        out: Math.min(1, 0.6 * edge + 0.4 * depth),
      });
    }
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  const positions = [];
  const normals = [];
  const corners = [];
  const details = [];
  const ups = [];
  const indices = [];
  for (const [i, card] of cards.entries()) {
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      positions.push(card.at.x, card.at.y, card.at.z);
      normals.push(card.normal.x, card.normal.y, card.normal.z);
      corners.push(x, y);
      details.push(card.size, card.spin, card.phase, card.out);
      ups.push(card.at.y / height);
    }
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("vegCorner", new THREE.Float32BufferAttribute(corners, 2));
  geometry.setAttribute("vegCard", new THREE.Float32BufferAttribute(details, 4));
  geometry.setAttribute("vegUp", new THREE.Float32BufferAttribute(ups, 1));
  geometry.setIndex(indices);
  return { geometry, cards: cards.length, middle, reach };
}

/** The same cards as `geometry`, drawing only the first `share` of them. */
function thinned(geometry, cards, share) {
  const thin = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    thin.setAttribute(name, attribute);
  }
  thin.setIndex(geometry.index);
  thin.setDrawRange(0, Math.max(1, Math.floor(cards * share)) * 6);
  return thin;
}

/** The view's up direction in view space: what a crown or a leaf is lit by, as the grass. */
const VIEW_UP = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);

/** A cut-out's alpha from its signed distance `d` (positive inside), smooth over one pixel. */
const cutOut = (d) => clamp(d.div(max(fwidth(d), 1e-4)).add(0.5), 0, 1);

/**
 * A rough PBR node material for a crown's cards, drawn by an instanced, `rooted` mesh. The vertex
 * stage sways and flutters each card, picks its band from a normal that points out of the crown,
 * and spreads it from its centre across the view, so it faces the camera from anywhere. Its normal
 * points up, so the scene's lights, fog and shadows fall on a crown as on the grass, and the bands
 * are its colors. `u` holds the uniforms: `wind` (strength, time), `sun` (toward the sun),
 * `bands` (lit, mid, dark, deep), `crown` (card scale, band softness, the tree's height, rim
 * light) and `leafKind` (0 lobed, 1 needle, 2 round).
 */
function crownMaterial(u) {
  const color = varyingProperty("vec3", "vegColor");
  const leaf = varyingProperty("vec3", "vegLeaf");
  const material = new FoliageMaterial({
    alphaTest: 0.5,
    alphaToCoverage: true,
  });
  material.positionNode = Fn(() => {
    const root = attribute("vegRoot", "vec4");
    const card = attribute("vegCard", "vec4"); // size, spin, phase, how near the crown's edge
    const corner = attribute("vegCorner", "vec2");
    const base = modelWorldMatrix.mul(vec4(root.xyz, 1)).xyz.toVar();
    const scale = root.w;
    // The trunk's sway, then a few centimetres of flutter of the card's own.
    const centre = modelWorldMatrix
      .mul(vec4(positionLocal, 1))
      .xyz.add(SWAY(base, attribute("vegUp", "float"), u.crown.z.mul(scale), u.wind))
      .add(
        sin(u.wind.y.mul(vec3(2.3, 3.1, 2.7)).add(card.z.mul(vec3(40, 17, 29))))
          .mul(0.035)
          .mul(min(u.wind.x, 2)),
      )
      .toVar();

    // Lit by a normal that points out of the crown, then cut into bands: a few flat tones.
    const outward = normalize(modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz);
    const lit = dot(outward, u.sun).mul(0.5).add(0.5);
    const tone = lit
      .mul(mix(0.45, 1, card.w))
      .add(card.z.sub(0.5).mul(0.06))
      .toVar();
    /** How far the tone is past a band's edge, over a width of the band softness. */
    const past = (edge) => smoothstep(u.crown.y.negate().add(edge), u.crown.y.add(edge), tone);
    const lit0 = u.bands.element(0);
    const banded = mix(
      mix(mix(u.bands.element(3), u.bands.element(2), past(0.23)), u.bands.element(1), past(0.45)),
      lit0,
      past(0.69),
    );
    const rim = pow(max(dot(normalize(cameraPosition.sub(centre)), u.sun.negate()), 0), 4)
      .mul(u.crown.w)
      .mul(card.w);
    const seed = fract(sin(dot(base.xz, vec2(12.9898, 78.233))).mul(43758.5453));
    color.assign(banded.add(lit0.mul(rim)).mul(mix(0.9, 1.1, seed)));

    const spin = card.y.mul(6.2831853).toVar();
    const offset = vec2(
      corner.x.mul(cos(spin)).sub(corner.y.mul(sin(spin))),
      corner.x.mul(sin(spin)).add(corner.y.mul(cos(spin))),
    )
      .mul(card.x.mul(scale).mul(u.crown.x))
      .toVar();
    leaf.assign(vec3(corner, u.leafKind));
    // Spread across the view: the camera's right and up, as in view space.
    const spread = centre
      .add(cameraWorldMatrix.element(0).xyz.mul(offset.x))
      .add(cameraWorldMatrix.element(1).xyz.mul(offset.y));
    return modelWorldMatrixInverse.mul(vec4(spread, 1)).xyz;
  })();
  material.normalNode = VIEW_UP;
  material.colorNode = vec4(color, 1);
  // A leaf's outline on its card: lobed, needles or round.
  const angle = atan(leaf.y, leaf.x).toVar();
  const lobed = float(0.72)
    .add(cos(angle.mul(7)).mul(0.16))
    .add(cos(angle.mul(13)).mul(0.07));
  const needle = float(0.62).add(pow(abs(cos(angle.mul(5.5))), 3).mul(0.3));
  const round = float(0.8).add(cos(angle.mul(5)).mul(0.08));
  const edge = mix(mix(lobed, needle, step(0.5, leaf.z)), round, step(1.5, leaf.z));
  material.opacityNode = cutOut(edge.sub(length(leaf.xy)));
  return material;
}

/**
 * The shade of the crowns on the ground, as a map over the square the trees stand in: each leaf
 * cluster leaves a soft ellipse where the sun throws it, longer for a lower sun, dappled. It
 * stands in for the crowns' shadows, which the shadow map does not see: a card has no shape in it.
 * The map reaches past the outermost trunks as far as the lowest sun throws the tallest crown.
 */
function shadeMap(placed, strength) {
  const box = new THREE.Box2();
  const cast = new THREE.Vector3();
  const at = new THREE.Vector3();
  let reach = 0;
  for (const tree of placed) {
    box.expandByPoint(new THREE.Vector2(tree.position.x, tree.position.z));
    for (const cluster of tree.template.clusters) {
      at.copy(cluster.centre).applyMatrix4(tree.matrix);
      const thrown = (at.y - tree.position.y) / LOWEST_SUN;
      reach = Math.max(reach, thrown + cluster.radius * tree.scale * LONGEST_SHADE);
    }
  }
  const span = box.getSize(new THREE.Vector2());
  // Two texels more on each side: the map's edge texel stays clear.
  const inner = Math.max(span.x, span.y) + reach * 2;
  const size = inner + 4 * Math.max(1, inner / 1020);
  const middle = box.getCenter(new THREE.Vector2());
  const resolution = THREE.MathUtils.clamp(Math.ceil(size), 16, 1024);
  const min = { x: middle.x - size / 2, z: middle.y - size / 2 };
  const data = new Uint8Array(resolution * resolution);
  const map = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  return {
    map,
    area: new THREE.Vector4(min.x, min.z, size, strength),
    /** Whether the shade is still that of a sun in `towardSun`. */
    current: (towardSun) => cast.equals(towardSun) || cast.dot(towardSun) > 0.9997,
    /** Casts every cluster again for a sun in `towardSun`. */
    cast(towardSun) {
      cast.copy(towardSun);
      data.fill(0);
      if (towardSun.lengthSq() === 0) {
        map.needsUpdate = true;
        return;
      }
      // A sun near the horizon would throw the shade without end: it is held at 15 degrees.
      const rise = Math.max(towardSun.y, LOWEST_SUN);
      const flat = Math.hypot(towardSun.x, towardSun.z);
      const hx = flat > 1e-6 ? towardSun.x / flat : 1;
      const hz = flat > 1e-6 ? towardSun.z / flat : 0;
      const texels = resolution / size;
      for (const tree of placed) {
        for (const cluster of tree.template.clusters) {
          at.copy(cluster.centre).applyMatrix4(tree.matrix);
          const radius = cluster.radius * tree.scale;
          const thrown = ((at.y - tree.position.y) * flat) / rise;
          const x = at.x - hx * thrown;
          const z = at.z - hz * thrown;
          const long = Math.min(radius / rise, radius * LONGEST_SHADE);
          // The map's edge stays clear, so the ground beyond it is in the open.
          const x0 = Math.max(1, Math.floor((x - long - min.x) * texels));
          const x1 = Math.min(resolution - 2, Math.ceil((x + long - min.x) * texels));
          const z0 = Math.max(1, Math.floor((z - long - min.z) * texels));
          const z1 = Math.min(resolution - 2, Math.ceil((z + long - min.z) * texels));
          for (let tz = z0; tz <= z1; tz += 1) {
            for (let tx = x0; tx <= x1; tx += 1) {
              const px = min.x + (tx + 0.5) / texels;
              const pz = min.z + (tz + 0.5) / texels;
              const dx = px - x;
              const dz = pz - z;
              const away = Math.hypot((dx * hx + dz * hz) / long, (dz * hx - dx * hz) / radius);
              if (away >= 1) {
                continue;
              }
              const dapple = 0.7 + 0.3 * valueNoise(px * 0.9, pz * 0.9);
              const value = (1 - THREE.MathUtils.smoothstep(away, 0.45, 1)) * dapple * 255;
              const i = tz * resolution + tx;
              data[i] = Math.max(data[i], value);
            }
          }
        }
      }
      map.needsUpdate = true;
    },
  };
}

/**
 * Trees drawn in code at `spots` (from `scatter`, or { x, z, y?, rotation?, scale?, kind? }).
 * `styles[kind]` is a name of CANOPY_STYLES or { style, ...changes }: `colors` (four, lit to deep
 * shade), `bark`, `height` and the rest of a style. Each style grows `variants` different trees
 * from `seed`, and every tree is one of them by instancing: a few draws whatever their number.
 * Past `farDistance` metres a crown draws a third of its cards, larger; nothing is drawn past
 * `distance`. `soft` widens the edges between a crown's color bands (0.02 flat tones, 0.2 a
 * smooth gradient). `shade` (0 to 1, 0 for none) is how dark the crowns' shade is: `trees.shade`
 * goes to `createGrass`. The sun is the scene's first directional light unless `sun` names one.
 * Returns { object, update(camera, delta, { wind }), pushOut(position, radius), trunks(), shade,
 * crowns, stats, dispose() }, as `createTrees` does.
 */
export function createCanopyTrees(
  styles,
  spots,
  {
    heightAt = () => 0,
    farDistance = 55,
    distance = 300,
    variants = 3,
    seed = 1,
    soft = 0.02,
    shade: shadeStrength = 0.45,
    shadows = true,
    sun,
  } = {},
) {
  const object = new THREE.Group();
  object.name = "canopy-trees";
  const next = random(seed * 6151 + 3);
  const wind = { vegWind: uniform(new THREE.Vector2(1, 0)).setName("vegWind") };
  const towardSun = uniform(NOON.clone()).setName("vegSun");
  /** A far crown draws 35% of its cards, enlarged so it covers as much. */
  const thin = 0.35;

  const kinds = styles.map(resolveStyle).map((style) =>
    Array.from({ length: variants }, () => {
      const tree = growTree(style, next);
      const crown = crownGeometry(tree.clusters, style, tree.height, next);
      const cards = (scale) =>
        crownMaterial({
          wind: wind.vegWind,
          sun: towardSun,
          bands: uniformArray(style.bands, "color").setName("vegBands"),
          crown: uniform(new THREE.Vector4(scale, soft, tree.height, 0.45)).setName("vegCrown"),
          leafKind: uniform(style.leafKind).setName("vegLeafKind"),
        });
      return {
        style,
        height: tree.height,
        clusters: tree.clusters,
        middle: crown.middle,
        reach: crown.reach,
        parts: [
          {
            geometry: trunkGeometry(tree.tubes, style, tree.height, next),
            material: swaying(
              new FoliageMaterial({
                vertexColors: true,
              }),
              tree.height,
              wind,
            ),
            castShadow: shadows,
          },
          { geometry: crown.geometry, material: cards(1), far: false },
          {
            geometry: thinned(crown.geometry, crown.cards, thin),
            material: cards(0.9 / Math.sqrt(thin)),
            far: true,
          },
        ],
      };
    }),
  );

  const placed = [];
  for (const spot of spots) {
    const templates = kinds[spot.kind ?? 0];
    if (!templates) {
      continue;
    }
    const position = new THREE.Vector3(spot.x, spot.y ?? heightAt(spot.x, spot.z), spot.z);
    const scale = spot.scale ?? 1;
    placed.push({
      template: templates[Math.floor(next() * variants)],
      position,
      scale,
      matrix: new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromAxisAngle(UP, spot.rotation ?? 0),
        new THREE.Vector3().setScalar(scale),
      ),
    });
  }
  for (const template of kinds.flat()) {
    const count = placed.filter((tree) => tree.template === template).length;
    for (const part of template.parts) {
      part.mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(count, 1));
      part.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      rooted(part.mesh);
      part.mesh.count = 0;
      // Trees are culled here, by the camera; a mesh's own bounds would be one tree's.
      part.mesh.frustumCulled = false;
      part.mesh.castShadow = part.castShadow ?? false;
      part.mesh.receiveShadow = true;
      object.add(part.mesh);
    }
  }

  const shade =
    shadeStrength > 0 && placed.length > 0 ? shadeMap(placed, shadeStrength) : undefined;
  const findSun = sunTracker(object, sun);
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const eye = new THREE.Vector3();
  const stats = { near: 0, far: 0 };
  let time = 0;

  return {
    object,
    stats,
    /** The crowns' shade on the ground ({ map, area }), for `createGrass({ shade })`. */
    shade: shade && { map: shade.map, area: shade.area },
    /** Each tree's crown, for what falls from it: { centre, radius, foot, colors, speed, ... }. */
    crowns: placed.map(({ template, position, scale, matrix }, index) => ({
      centre: template.middle.clone().applyMatrix4(matrix),
      radius: template.reach * scale,
      foot: position.y,
      seed: (index * 0.6180339887) % 1,
      colors: template.style.bands,
      speed: template.style.fall ?? 0.85,
      petals: template.style.leafKind === 2,
      sheds: template.style.sheds !== false,
    })),
    /** Culls the trees to the view, thins the far crowns and follows the wind and the sun. */
    update(camera, delta, { wind: strength = 1 } = {}) {
      time += delta;
      wind.vegWind.value.set(strength, time);
      findSun(delta, towardSun.value);
      if (shade && !shade.current(towardSun.value)) {
        shade.cast(towardSun.value);
      }
      // The bands retain a stable artistic direction when there is no directional light;
      // the projected shade above is cleared, and PBR lighting still comes from the scene.
      if (towardSun.value.lengthSq() === 0) {
        towardSun.value.copy(NOON);
      }
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      camera.getWorldPosition(eye);
      for (const template of kinds.flat()) {
        for (const part of template.parts) {
          part.mesh.count = 0;
        }
      }
      stats.near = 0;
      stats.far = 0;
      for (const { template, position, scale, matrix } of placed) {
        const away = Math.hypot(position.x - eye.x, position.z - eye.z);
        if (away > distance) {
          continue;
        }
        sphere.center.copy(position).setY(position.y + template.height * scale * 0.55);
        sphere.radius = (Math.max(template.height * 0.55, template.reach) + 1.5) * scale;
        if (!frustum.intersectsSphere(sphere)) {
          continue;
        }
        const isFar = away > farDistance;
        for (const part of template.parts) {
          if (part.far === undefined || part.far === isFar) {
            part.mesh.setMatrixAt(part.mesh.count, matrix);
            part.mesh.geometry.attributes.vegRoot.setXYZW(part.mesh.count, ...position, scale);
            part.mesh.count += 1;
          }
        }
        stats[isFar ? "far" : "near"] += 1;
      }
      for (const template of kinds.flat()) {
        for (const { mesh } of template.parts) {
          uploadCopies(mesh);
        }
      }
    },
    ...trunkGuard(placed, (tree) => tree.template.style.trunk),
    dispose() {
      object.removeFromParent();
      for (const template of kinds.flat()) {
        for (const { mesh } of template.parts) {
          mesh.geometry.dispose();
          mesh.material.dispose();
          mesh.dispose();
        }
      }
      shade?.map.dispose();
    },
  };
}

/** `v` turned about x by `t`, the other way round from the right-hand rule. */
const turnX = (t, v) =>
  mat3(vec3(1, 0, 0), vec3(0, cos(t), sin(t).negate()), vec3(0, sin(t), cos(t))).mul(v);
/** `v` turned about y by `t`, the other way round from the right-hand rule. */
const turnY = (t, v) =>
  mat3(vec3(cos(t), 0, sin(t)), vec3(0, 1, 0), vec3(sin(t).negate(), 0, cos(t))).mul(v);

/**
 * Leaves falling from the crowns of `trees` (from `createCanopyTrees`): `perTree` leaves from each
 * of the `count` trees nearest the camera within `distance` metres over the ground, in the trees'
 * own colors, in one draw. They drift with the wind, tumble, land and lie a while. `ground` (`grass.ground`) lets
 * them land on the ground's own height; without it they land level with their tree's foot. Returns
 * { object, update(camera, delta, { wind }), stats, dispose() }.
 */
export function createFallingLeaves(
  trees,
  { perTree = 24, count = 96, distance = 45, size = 0.09, ground } = {},
) {
  const crowns = trees.crowns.filter((crown) => crown.sheds);
  const slots = Math.max(1, Math.min(count, crowns.length));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  shaped(geometry);
  geometry.instanceCount = 0;
  /**
   * Four entries a tree, shared by its leaves: its crown's centre and radius, its lighter color
   * and how fast its leaves fall, its darker color and its foot (y), and its seed and whether it
   * sheds petals.
   */
  const perCrown = Array.from({ length: slots * 4 }, () => new THREE.Vector4());
  const crownData = uniformArray(perCrown, "vec4");

  const wind = uniform(new THREE.Vector2(1, 0)).setName("vegWind");
  // Without the ground's map a leaf lands level with its tree's foot.
  const groundAt = ground && GROUND({ map: ground.map, area: uniform(ground.area) }).ground;
  const { hash4, noise } = NOISE;
  const color = varyingProperty("vec3", "vegColor");
  const leafShape = varyingProperty("vec3", "vegLeaf");
  const material = new FoliageMaterial({
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    alphaToCoverage: true,
  });
  // A leaf's place is worked out from the time alone: nothing is stored or simulated.
  material.positionNode = Fn(() => {
    const slot = instanceIndex.div(uint(perTree)).mul(uint(4)).toVar();
    const crownAt = crownData.element(slot).toVar();
    const tintA = crownData.element(slot.add(uint(1))).toVar();
    const tintB = crownData.element(slot.add(uint(2))).toVar();
    const tree = crownData.element(slot.add(uint(3))).toVar();
    const leaf = float(instanceIndex.mod(uint(perTree))).toVar();
    const r = hash4(vec2(leaf.mul(1.37).add(0.5), tree.x.mul(91.7).add(leaf))).toVar();
    const period = mix(7, 13, r.x).toVar();
    const clock = wind.y.add(r.y.mul(period)).toVar();
    const fallen = fract(clock.div(period)).mul(period).toVar();
    // A new place in the crown every time round.
    const start = hash4(
      vec2(floor(clock.div(period)).add(leaf.mul(3.3)), tree.x.mul(7.7).add(leaf)),
    ).toVar();
    const direction = noise(crownAt.xz.mul(0.05).add(wind.y.mul(0.05)));
    const swing = mix(1.2, 2.4, r.z).toVar();
    const drift = vec2(
      sin(fallen.mul(swing).add(r.w.mul(6.28))),
      cos(fallen.mul(swing).mul(0.8).add(r.w.mul(6.28))),
    )
      .mul(0.45)
      .add(vec2(cos(direction), sin(direction)).mul(fallen.mul(0.45).mul(wind.x)));
    const from = crownAt.xyz.add(
      start.xyz
        .sub(0.5)
        .mul(crownAt.w)
        .mul(vec3(1.5, 0.6, 1.5)),
    );
    const xz = from.xz.add(drift).toVar();
    const height = from.y.sub(fallen.mul(tintA.w)).toVar();
    const floorHeight = (groundAt ? groundAt(xz).x : tintB.w).add(0.03).toVar();
    const landed = height.lessThanEqual(floorHeight);

    // It tumbles on the way down and lies flat once landed; it grows in and shrinks away.
    const share = fallen.div(period).toVar();
    const grown = float(size)
      .mul(smoothstep(0, 0.05, share))
      .mul(float(1).sub(smoothstep(0.88, 1, share)));
    const corner = vec3(positionGeometry.x.mul(0.55), positionGeometry.y, 0);
    const lying = turnY(start.w.mul(6.28), turnX(1.5708, corner));
    const tumbling = turnX(
      fallen.mul(mix(1.5, 3, r.z)),
      turnY(fallen.mul(mix(1, 2.5, r.w)), corner),
    );
    color.assign(mix(tintB.rgb, tintA.rgb, r.z));
    leafShape.assign(vec3(positionGeometry.xy, tree.y));
    return vec3(xz.x, max(height, floorHeight), xz.y).add(
      select(landed, lying, tumbling).mul(grown),
    );
  })();
  // Lit from above whichever side shows, so a leaf does not flash dark as it turns over.
  material.normalNode = VIEW_UP;
  material.colorNode = vec4(color, 1);
  // A leaf's outline on its quad: a pointed leaf, or a petal with a notch at its tip.
  const pointed = pow(max(float(1).sub(leafShape.y.mul(leafShape.y)), 0), 0.8)
    .mul(0.95)
    .sub(abs(leafShape.x));
  const petal = min(
    float(0.95).sub(length(leafShape.xy.mul(vec2(1, 0.9)))),
    length(leafShape.xy.sub(vec2(0, 0.95))).sub(0.28),
  );
  material.opacityNode = cutOut(mix(pointed, petal, step(0.5, leafShape.z)));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "falling-leaves";
  // The leaves are placed by the shader; the mesh's own bounds would be one quad's.
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;

  const eye = new THREE.Vector3();
  const stats = { trees: 0, leaves: 0 };
  let time = 0;

  return {
    object: mesh,
    stats,
    /** Gives the leaves to the trees nearest the camera and moves the wind. */
    update(camera, delta, { wind: strength = 1 } = {}) {
      time += delta;
      wind.value.set(strength, time);
      camera.getWorldPosition(eye);
      const nearest = crowns
        .map((crown) => ({
          crown,
          // Over the ground, as the trees and the grass measure: a camera high above still counts.
          away: Math.hypot(crown.centre.x - eye.x, crown.centre.z - eye.z),
        }))
        .filter(({ away }) => away <= distance)
        .sort((a, b) => a.away - b.away)
        .slice(0, slots);
      for (const [i, { crown }] of nearest.entries()) {
        const [light, dark] = crown.colors;
        perCrown[i * 4].set(crown.centre.x, crown.centre.y, crown.centre.z, crown.radius);
        perCrown[i * 4 + 1].set(light.r, light.g, light.b, crown.speed);
        perCrown[i * 4 + 2].set(dark.r, dark.g, dark.b, crown.foot);
        perCrown[i * 4 + 3].set(crown.seed, crown.petals ? 1 : 0, 0, 0);
      }
      geometry.instanceCount = nearest.length * perTree;
      stats.trees = nearest.length;
      stats.leaves = geometry.instanceCount;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
