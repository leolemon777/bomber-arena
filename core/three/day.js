// The day's light, hour by hour: keys measured against SkyMesh's physical sky, and every hour
// between them interpolated, so time passes without a step (lighting.js applies it).
import * as THREE from "three";

const SUN_LOW = new THREE.Color(0xff7a30);
const SUN_HIGH = new THREE.Color(0xfff2e3);

/**
 * The day's keys, by hour. `sun` is where the sky's sun stands (elevation and azimuth in degrees;
 * below the horizon at night). `light` is the light that shines: the sun by day, the moon by
 * night, with its color and intensity next to the sky. `exposure` brings both to the screen and
 * `fog` is the horizon's color. The named times are these hours.
 */
const MOON = { elevation: 40, azimuth: 160, color: "#9fb6ff", intensity: 0.35 };
const NIGHT_FOG = "#141b29";
export const DAY = Object.freeze([
  { hour: 4.5, sun: [-10, 70], light: MOON, exposure: 3, fog: NIGHT_FOG },
  {
    hour: 6,
    name: "dawn",
    sun: [5, 85],
    light: "sun",
    intensity: 12,
    exposure: 0.34,
    fog: "#d9a07a",
  },
  {
    hour: 7.5,
    name: "morning",
    sun: [12, 100],
    light: "sun",
    intensity: 22,
    exposure: 0.14,
    fog: "#dcc3a8",
  },
  {
    hour: 12,
    name: "noon",
    sun: [70, 180],
    light: "sun",
    intensity: 46,
    exposure: 0.035,
    fog: "#c5d3df",
  },
  {
    hour: 15.5,
    name: "afternoon",
    sun: [41, 235],
    light: "sun",
    intensity: 40,
    exposure: 0.08,
    fog: "#cbd5dc",
  },
  {
    hour: 18.5,
    name: "dusk",
    sun: [5, 270],
    light: "sun",
    intensity: 12,
    exposure: 0.34,
    fog: "#d4956a",
  },
  { hour: 21.5, name: "night", sun: [-10, 290], light: MOON, exposure: 3, fog: NIGHT_FOG },
]);
export const TIMES = Object.freeze(
  Object.fromEntries(DAY.filter((k) => k.name).map((k) => [k.name, k.hour])),
);

export const direction = (elevation, azimuth, target = new THREE.Vector3()) =>
  target.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevation),
    THREE.MathUtils.degToRad(azimuth),
  );
const logLerp = (a, b, t) => Math.exp(THREE.MathUtils.lerp(Math.log(a), Math.log(b), t));
/** An angle's way from `a` to `b` the short way round, in degrees. */
const angleLerp = (a, b, t) => a + (((((b - a) % 360) + 540) % 360) - 180) * t;

/** The light of a key: the sun's at its elevation, or the moon's. */
function keyLight(key) {
  if (key.light === "sun") {
    const [elevation, azimuth] = key.sun;
    return {
      elevation,
      azimuth,
      intensity: key.intensity,
      // The sun warms towards the horizon.
      color: new THREE.Color().lerpColors(
        SUN_LOW,
        SUN_HIGH,
        THREE.MathUtils.clamp(elevation / 30, 0, 1),
      ),
    };
  }
  return { ...key.light, color: new THREE.Color(key.light.color) };
}

/** Everything the light is at `hour`, interpolated between the two keys around it. */
export function dayAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = DAY.findIndex((key) => key.hour > h);
  if (i < 0) i = 0;
  const next = DAY[i];
  const previous = DAY[(i + DAY.length - 1) % DAY.length];
  const span = (next.hour - previous.hour + 24) % 24 || 24;
  const t = ((h - previous.hour + 24) % 24) / span;
  const a = keyLight(previous);
  const b = keyLight(next);
  return {
    hour: h,
    sun: [
      THREE.MathUtils.lerp(previous.sun[0], next.sun[0], t),
      angleLerp(previous.sun[1], next.sun[1], t),
    ],
    light: {
      elevation: THREE.MathUtils.lerp(a.elevation, b.elevation, t),
      azimuth: angleLerp(a.azimuth, b.azimuth, t),
      intensity: logLerp(a.intensity, b.intensity, t),
      color: a.color.clone().lerp(b.color, t),
    },
    exposure: logLerp(previous.exposure, next.exposure, t),
    fog: new THREE.Color(previous.fog).lerp(new THREE.Color(next.fog), t),
  };
}
