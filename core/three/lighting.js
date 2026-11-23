// A game's light, from one source: the sun by day, the moon by night. The sky, the reflections and
// ambient light (from that sky, not from a room), the fog's color and the exposure all follow it,
// so a game is lit consistently whatever it shows. A game chooses a time of day, a grade and a
// style. Indoor games can turn off the outdoor environment. references/lighting.md has the whole
// contract:
//
//   lighting.setTime("dusk")        // "dawn", "morning", "noon", "afternoon", "dusk", "night"
//   lighting.setTime(17.25)         // or any hour, 0 to 24: call it every frame for a day passing
//   lighting.setGrade("warm")       // "natural", "warm", "cool", "film"
//   lighting.setStyle("painted")    // "natural"; "painted" for hand-painted shading; "flat" for
//                                   //   unlit, toon or pixel-art materials at their own colors
//   lighting.setWeather({ clouds: 0.7 })   // cloud cover from 0 to 1
//   lighting.addEmitter(torch, { color: "#ff9a4a", radius: 14 })   // light near the ground
//   lighting.setLevel(level)  // register its bounds; realtime light, no bake
//   lighting.setLevel(level, { indirect: "baked", lights: [lighting.sun] }) // fixed lighting only
//
// The keys of the day were measured against SkyMesh's physical sky: its radiance is in the tens,
// so the light's intensity and the exposure are set together, and the exposure differs nearly
// tenfold between noon and dusk. Between keys every value is interpolated (intensities and
// exposure on a log scale), so time passes without a step. Custom environments can supply their own exposure.
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { SunLightNode } from "three/addons/lights/SunLightNode.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import {
  densityFogFactor,
  exp,
  fog,
  max,
  positionWorld,
  sin,
  texture,
  time,
  uniform,
} from "three/tsl";
import { createBaker } from "./bake.js";
import { TIMES, dayAt, direction } from "./day.js";

export { DAY, TIMES, dayAt } from "./day.js";

/** Grades on display colors: white balance, saturation, contrast, a tint for shadows and highlights. */
export const GRADES = Object.freeze({
  natural: {
    tint: [1, 1, 1],
    saturation: 1,
    contrast: 1,
    shadows: [0, 0, 0],
    highlights: [0, 0, 0],
  },
  warm: {
    tint: [1.07, 1.0, 0.88],
    saturation: 1.15,
    contrast: 1.06,
    shadows: [0.01, 0, -0.01],
    highlights: [0.03, 0.015, -0.02],
  },
  cool: {
    tint: [0.92, 0.99, 1.07],
    saturation: 0.8,
    contrast: 1.12,
    shadows: [-0.01, 0, 0.025],
    highlights: [0, 0.005, 0.01],
  },
  film: {
    tint: [1.02, 1.0, 0.97],
    saturation: 1.08,
    contrast: 1.1,
    shadows: [-0.035, 0.01, 0.045],
    highlights: [0.045, 0.015, -0.035],
  },
});

/**
 * Styles. "painted" is for textures whose shading is part of the look (a hand-painted style): the
 * sun's contrast is lower, the sky's light higher, and ambient occlusion lighter, so the painted
 * shading leads instead of being darkened twice. "flat" is for unlit, toon and pixel-art
 * materials: the exposure is 1, so a MeshBasicMaterial shows its own colors, the lights are
 * brought to that scale instead, the sky is drawn as its horizon color and nothing is occluded.
 */
export const STYLES = Object.freeze({
  natural: { sun: 1, environment: 1, occlusion: 1, flat: false },
  painted: { sun: 0.7, environment: 1.6, occlusion: 0.4, flat: false },
  flat: { sun: 0.8, environment: 1.4, occlusion: 0, flat: true },
});

const SUN_HIGH = new THREE.Color(0xfff2e3);
const ENVIRONMENT = 0.5;
/** How far the sun moves before the environment is rebuilt, and how often at most. */
const ENVIRONMENT_STEP = { degrees: 2, ms: 1000 };
/** The glow's strength against the night's exposure; a light arriving at a surface. */
const GLOW = 2.5;

/** The area the glow map covers when no level gives one, in metres around the origin. */
const GLOW_AREA = 256;
const GLOW_TEXELS = 1024;

/**
 * Light near the ground from many emitters at the cost of one texture read: each emitter's spill is
 * drawn once into a map seen from above, and every surface reads it at its own x and z, fading over
 * a few metres of height. Being a light of its own type, it reaches every material in the scene.
 */
class GlowMapLight extends THREE.Light {
  constructor() {
    super(0xffffff, 1);
    this.isGlowMapLight = true;
    this.type = "GlowMapLight";
    this.map = null;
    this.area = new THREE.Vector4(0, 0, GLOW_AREA, GLOW_AREA);
  }
}

class GlowMapLightNode extends THREE.AnalyticLightNode {
  static get type() {
    return "GlowMapLightNode";
  }

  constructor(light = null) {
    super(light);
    this.areaNode = uniform(new THREE.Vector4());
    this.strengthNode = uniform(0);
  }

  update(frame) {
    super.update(frame);
    this.areaNode.value.copy(this.light.area);
    this.strengthNode.value = this.light.intensity;
  }

  setup({ context }) {
    const { map } = this.light;
    if (!map) {
      return;
    }
    const area = this.areaNode;
    const uv = positionWorld.xz.sub(area.xy).div(area.zw).add(0.5);
    const fade = exp(max(positionWorld.y.sub(0.2), 0).div(5).negate());
    // Fire does not hold still: a slow breath and a faster flutter.
    const flicker = sin(time.mul(11))
      .mul(0.07)
      .add(sin(time.mul(6.3).add(1)).mul(0.05))
      .add(1);
    context.irradiance.addAssign(
      texture(map, uv).rgb.mul(this.strengthNode).mul(fade).mul(flicker),
    );
  }
}

const registered = new WeakSet();

/** The lighting of one game version; the runtime makes one with each scene and disposes it. */
export function createLighting({ scene, renderer, camera }) {
  if (!registered.has(renderer.library)) {
    renderer.library.addLight(SunLightNode, SunLight);
    renderer.library.addLight(GlowMapLightNode, GlowMapLight);
    registered.add(renderer.library);
  }

  const sky = new SkyMesh();
  sky.scale.setScalar(camera.far * 0.9);
  sky.turbidity.value = 4;
  sky.rayleigh.value = 1.6;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.8;
  sky.cloudSpeed.value = 0;
  sky.cloudDensity.value = 0.25 + sky.cloudCoverage.value * 0.6;
  sky.name = "sky";
  scene.add(sky);

  const sun = new SunLight(SUN_HIGH, 40);
  sun.name = "sun";
  sun.castShadow = true;
  sun.shadow.camera.far = 300;
  sun.shadow.mapSize.setScalar(2048);
  sun.shadow.normalBias = 0.05;
  scene.add(sun);

  const glow = new GlowMapLight();
  glow.name = "glow";
  scene.add(glow);

  // Reflections and ambient light come from a copy of the same sky, rebuilt when the sun moves.
  const environmentSky = sky.clone();
  const environmentScene = new THREE.Scene();
  environmentScene.add(environmentSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let environmentTarget = null;
  const environmentAt = {
    direction: new THREE.Vector3(),
    time: -Infinity,
    clouds: NaN,
    dirty: true,
    updates: 0,
  };
  let customEnvironment;
  let customExposure;
  let customBackground = null;
  let environmentIntensity = 1;

  // The distance haze of the time of day, and a mist lying on the ground that thins out within a
  // few metres of height.
  const fogColor = uniform(new THREE.Color());
  const haze = uniform(0.0016);
  const mist = uniform(0.012);
  const mistHeight = uniform(8);
  const fogNode = fog(
    fogColor,
    max(
      densityFogFactor(haze),
      densityFogFactor(mist).mul(exp(max(positionWorld.y, 0).div(mistHeight).negate())),
    ),
  );

  /**
   * What the post pipeline reads (post.js): exposure, grade, the occlusion's weight, a vignette
   * (on) and film grain (off: moving noise reads as a fault, so only a game that asks for an old
   * film look turns it on).
   */
  const look = {
    exposure: uniform(1),
    occlusion: uniform(1),
    vignette: uniform(1),
    grain: uniform(0),
    bloom: uniform(1),
    grade: {
      tint: uniform(new THREE.Vector3(1, 1, 1)),
      saturation: uniform(1),
      contrast: uniform(1),
      shadows: uniform(new THREE.Vector3()),
      highlights: uniform(new THREE.Vector3()),
    },
  };

  const emitters = [];
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = GLOW_TEXELS;
  glow.map = new THREE.CanvasTexture(glowCanvas);
  glow.map.colorSpace = THREE.SRGBColorSpace;
  glow.map.flipY = false; // canvas rows run with world z
  let occlusionStrength;
  let glowDirty = false;
  const state = {
    hour: TIMES.afternoon,
    grade: "natural",
    style: "natural",
    clouds: sky.cloudCoverage.value,
    sky: true,
    sun: true,
    fog: true,
    indirect: "realtime",
  };
  const flatBackground = new THREE.Color();
  let baker = null;
  let level = null;
  let fixedLights = [];

  function invalidateBake(reason = "scene changed") {
    baker?.invalidate(reason);
  }

  /** Select the parts of the outdoor rig this game uses. Custom maps remain caller-owned. */
  function setEnvironment(options = {}) {
    const before = [
      state.sky,
      state.sun,
      state.fog,
      customEnvironment,
      customExposure,
      customBackground,
      environmentIntensity,
    ];
    if (options.sky !== undefined) state.sky = Boolean(options.sky);
    if (options.sun !== undefined) state.sun = Boolean(options.sun);
    if (options.fog !== undefined) state.fog = Boolean(options.fog);
    if ("map" in options) customEnvironment = options.map;
    if ("exposure" in options) customExposure = options.exposure;
    if ("background" in options) customBackground = options.background;
    if (options.intensity !== undefined) environmentIntensity = options.intensity;
    const after = [
      state.sky,
      state.sun,
      state.fog,
      customEnvironment,
      customExposure,
      customBackground,
      environmentIntensity,
    ];
    if (before.every((value, i) => value === after[i])) return;
    invalidateBake("environment changed");
    applyLight();
    environmentAt.dirty = true;
  }

  function setLevel(object, { indirect = "realtime", lights: sources } = {}) {
    if (!["realtime", "baked"].includes(indirect))
      throw new Error("Choose realtime or baked indirect light.");
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty())
      throw new Error("Add the level's meshes before registering it with lighting.setLevel().");
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    setGlowArea({ x: centre.x, z: centre.z, size: Math.max(size.x, size.z) + 40 });
    level = object;
    state.indirect = indirect;
    baker?.dispose();
    baker = null;
    if (indirect === "realtime") return Promise.resolve({ status: "realtime" });
    fixedLights = sources ?? (state.sun ? [sun] : []);
    baker = createBaker({ scene, renderer, sky, sun });
    baker.setLevel(level, fixedLights);
    return baker.bake();
  }

  function bake() {
    if (!baker) throw new Error('Choose indirect: "baked" in setLevel() before requesting a bake.');
    return baker.bake();
  }

  /** Sets every light value for the hour and style; cheap enough to run each frame. */
  function applyLight() {
    const day = dayAt(state.hour);
    const style = STYLES[state.style];
    const sunDirection = direction(day.sun[0], day.sun[1]);
    sky.sunPosition.value.copy(sunDirection);
    environmentSky.sunPosition.value.copy(sunDirection);
    direction(day.light.elevation, day.light.azimuth, sun.position);
    sun.color.copy(day.light.color);
    // The fog is mixed into the scene before exposure: its color is a horizon brightness on the
    // light's own scale, not a screen color, or distant things would fade towards black.
    const exposure = customExposure ?? (style.flat || !state.sky ? 1 : day.exposure);
    fogColor.value.copy(day.fog).multiplyScalar(1 / exposure);
    scene.fogNode = state.fog ? fogNode : null;
    look.occlusion.value = occlusionStrength ?? style.occlusion;
    // A flat style keeps the exposure at 1, so unlit colors show as they are, and brings the
    // lights down to that scale instead; the sky, too bright at that scale, is its horizon color.
    const scale = style.flat ? day.exposure : 1;
    look.exposure.value = exposure;
    sun.visible = state.sun;
    sun.intensity = day.light.intensity * style.sun * scale;
    scene.environmentIntensity =
      customEnvironment !== undefined
        ? environmentIntensity
        : ENVIRONMENT * style.environment * scale;
    if (customEnvironment !== undefined || !state.sky)
      scene.environment = customEnvironment ?? null;
    else if (environmentTarget) scene.environment = environmentTarget.texture;
    sky.visible = state.sky && !style.flat;
    if (!state.sky) {
      scene.background = customBackground;
    } else if (style.flat) {
      flatBackground.copy(day.fog);
      scene.background = flatBackground;
    } else if (scene.background === flatBackground || scene.background === customBackground) {
      scene.background = null;
    }
    glow.intensity = emitters.length ? GLOW * scale : 0;
    if (
      THREE.MathUtils.radToDeg(sunDirection.angleTo(environmentAt.direction)) >
      ENVIRONMENT_STEP.degrees
    ) {
      environmentAt.dirty = true;
    }
  }

  /** Rebuilds the environment from the sky once the sun has moved, at most once a second. */
  function refreshEnvironment(now) {
    if (!state.sky || customEnvironment !== undefined) return;
    const cloudsChanged = state.clouds !== environmentAt.clouds;
    environmentAt.dirty ||=
      cloudsChanged &&
      (Math.abs(state.clouds - environmentAt.clouds) >= 0.025 || now - environmentAt.time >= 5000);
    if (!environmentAt.dirty || now - environmentAt.time < ENVIRONMENT_STEP.ms) return;
    environmentAt.dirty = false;
    environmentAt.time = now;
    environmentAt.clouds = state.clouds;
    environmentAt.updates += 1;
    environmentAt.direction.copy(environmentSky.sunPosition.value);
    // Into the same target each time: a new environment texture would make every material in
    // the scene compile again, many times a second while the sun moves.
    environmentTarget = pmrem.fromScene(environmentScene, 0, 0.1, 100, {
      size: 64,
      renderTarget: environmentTarget,
    });
    scene.environment = environmentTarget.texture;
  }

  /** A named time or an hour from 0 to 24; call it every frame to let the day pass. */
  function setTime(when) {
    const hour = typeof when === "number" ? when : TIMES[when];
    if (hour === undefined || !Number.isFinite(hour)) {
      throw new Error(
        `lighting.setTime: "${when}" is not a time; use an hour from 0 to 24 or ${Object.keys(TIMES).join(", ")}.`,
      );
    }
    const next = ((hour % 24) + 24) % 24;
    if (state.hour !== next) invalidateBake("time changed");
    state.hour = next;
    applyLight();
  }

  function setGrade(name) {
    const g = GRADES[name];
    if (!g) {
      throw new Error(
        `lighting.setGrade: unknown grade "${name}"; use ${Object.keys(GRADES).join(", ")}.`,
      );
    }
    state.grade = name;
    look.grade.tint.value.fromArray(g.tint);
    look.grade.saturation.value = g.saturation;
    look.grade.contrast.value = g.contrast;
    look.grade.shadows.value.fromArray(g.shadows);
    look.grade.highlights.value.fromArray(g.highlights);
  }

  function setStyle(name) {
    if (!STYLES[name]) {
      throw new Error(
        `lighting.setStyle: unknown style "${name}"; use ${Object.keys(STYLES).join(", ")}.`,
      );
    }
    if (state.style !== name) invalidateBake("style changed");
    state.style = name;
    applyLight();
  }

  /** The lens: a soft vignette, on by default, and film grain, off by default. */
  function setLens({ vignette, grain, occlusion, bloom } = {}) {
    if (occlusion !== undefined) {
      occlusionStrength = THREE.MathUtils.clamp(occlusion, 0, 1);
      look.occlusion.value = occlusionStrength;
    }
    if (bloom !== undefined) look.bloom.value = THREE.MathUtils.clamp(bloom, 0, 1);
    if (vignette !== undefined) look.vignette.value = vignette ? 1 : 0;
    if (grain !== undefined) look.grain.value = grain ? 1 : 0;
  }

  /** Distance haze and ground mist; 0 turns either off. */
  function setFog({ density, mist: mistDensity, mistHeight: height } = {}) {
    if (density !== undefined) haze.value = density;
    if (mistDensity !== undefined) mist.value = mistDensity;
    if (height !== undefined) mistHeight.value = height;
  }

  /** Cloud cover from 0 (clear) to 1 (overcast); the sky's light follows the clouds. */
  function setWeather({ clouds } = {}) {
    if (clouds !== undefined) {
      const cover = THREE.MathUtils.clamp(clouds, 0, 1);
      if (cover === state.clouds) return;
      state.clouds = cover;
      invalidateBake("weather changed");
      for (const s of [sky, environmentSky]) {
        s.cloudCoverage.value = cover;
        s.cloudDensity.value = 0.25 + cover * 0.6;
      }
      // Visible clouds are continuous. Only the expensive reflection capture is throttled.
    }
  }

  function setGlowArea({ x, z, size }) {
    glow.area.set(x, z, size, size);
    glowDirty = emitters.length > 0;
  }

  /**
   * An emitter near the ground lights what is around it: a position or an object (its position is
   * read once, now and whenever the map is redrawn), a color, a reach in metres and a strength.
   * Returns a function that takes it away. Emitters that move with the player are point lights.
   */
  function addEmitter(at, { color = "#ff9a4a", radius = 14, intensity = 1 } = {}) {
    const emitter = { at, color: new THREE.Color(color), radius, intensity };
    emitters.push(emitter);
    glowDirty = true;
    return () => {
      const index = emitters.indexOf(emitter);
      if (index >= 0) {
        emitters.splice(index, 1);
        glowDirty = true;
      }
    };
  }

  function drawGlow() {
    glowDirty = false;
    const g = glowCanvas.getContext("2d");
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, GLOW_TEXELS, GLOW_TEXELS);
    g.globalCompositeOperation = "lighter";
    const [cx, cz, size] = [glow.area.x, glow.area.y, glow.area.z];
    const position = new THREE.Vector3();
    for (const { at, color, radius, intensity } of emitters) {
      const p = at.isObject3D ? at.getWorldPosition(position) : at;
      const x = ((p.x - cx) / size + 0.5) * GLOW_TEXELS;
      const y = ((p.z - cz) / size + 0.5) * GLOW_TEXELS;
      const r = (radius / size) * GLOW_TEXELS;
      const rgb = (a) =>
        `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${Math.min(1, a * intensity)})`;
      const gradient = g.createRadialGradient(x, y, 0, x, y, r);
      // About inverse-square near the source, ending smoothly at its reach.
      gradient.addColorStop(0, rgb(1));
      gradient.addColorStop(0.12, rgb(0.55));
      gradient.addColorStop(0.35, rgb(0.16));
      gradient.addColorStop(1, rgb(0));
      g.fillStyle = gradient;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    glow.map.needsUpdate = true;
    applyLight();
  }

  setGrade("natural");
  applyLight();
  drawGlow(); // bind a black texture before shader compilation; first ignition changes pixels only

  return {
    sun,
    sky,
    look,
    /** The hour now, 0 to 24. */
    get hour() {
      return state.hour;
    },
    setEnvironment,
    setTime,
    setGrade,
    setStyle,
    setFog,
    setLens,
    setWeather,
    addEmitter,
    setLevel,
    bake,
    invalidateBake,
    prepare() {
      refreshEnvironment(performance.now());
    },
    update() {
      if (glowDirty) drawGlow();
      refreshEnvironment(performance.now());
      baker?.update();
    },
    stats: () => ({
      ...state,
      hour: Math.round(state.hour * 100) / 100,
      emitters: emitters.length,
      environmentUpdates: environmentAt.updates,
      bake: baker?.stats() ?? { phase: "none", probes: 0, bakes: 0, failure: null },
    }),
    dispose() {
      baker?.dispose();
      // The caller owns custom maps, including when the runtime disposes the remaining scene.
      if (scene.environment === customEnvironment) scene.environment = null;
      if (scene.background === customBackground) scene.background = null;
      environmentTarget?.dispose();
      pmrem.dispose();
      glow.map?.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      sun.dispose?.();
    },
  };
}
