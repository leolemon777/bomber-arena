// Optional indirect light for a level under fixed lighting. Nothing is allocated until requested.
// A bake is runtime work, not an offline asset. Changes invalidate it; only an explicit bake()
// starts another job. Live day/night games use direct light and the environment instead.
import * as THREE from "three";
import { LightMapper } from "three/addons/lighting/LightMapper.js";
import { LightProbeGrid } from "three/addons/lighting/LightProbeGrid.js";
import { vxgiIrradiance } from "three/addons/lighting/vxgi/VXGIIrradiance.js";
import { VXGIVolume } from "three/addons/lighting/vxgi/VXGIVolume.js";
import { unwrapUVs } from "three/addons/utils/unwrapUVs.js";
import { lights } from "three/tsl";

const SAMPLES = 64;
const ATLAS = 2048;
const VOXELS = 160;
const MAX_PROBES = 700;
const PROBES_PER_FRAME = 32;

const attributeIds = new WeakMap();
let nextAttributeId = 0;
function geometryKey(geometry) {
  return [geometry.index, ...Object.values(geometry.attributes)]
    .map((attribute) => {
      if (!attribute) return "none";
      if (!attributeIds.has(attribute)) attributeIds.set(attribute, ++nextAttributeId);
      return `${attributeIds.get(attribute)}:${attribute.count}:${attribute.version}`;
    })
    .join(",");
}

// Inspect ordinary object state, not triangle data. Texture/attribute edits use needsUpdate as
// usual; applications with custom shader uniforms call invalidateBake() explicitly.
function sceneKey(level, sources) {
  level.updateWorldMatrix(true, true);
  const geometry = [];
  const surface = [];
  const bindings = [];
  level.traverse((o) => {
    geometry.push(o.id, o.visible);
    if (!o.isMesh) return;
    const g = o.geometry;
    geometry.push(...o.matrixWorld.elements, g.id, geometryKey(g));
    for (const m of [o.material].flat()) {
      bindings.push(m.id);
      surface.push(
        m.id,
        m.color?.getHex(),
        m.emissive?.getHex(),
        m.emissiveIntensity,
        m.roughness,
        m.metalness,
        m.opacity,
        m.alphaTest,
        m.side,
      );
      for (const name of [
        "map",
        "normalMap",
        "emissiveMap",
        "alphaMap",
        "roughnessMap",
        "metalnessMap",
      ])
        surface.push(m[name]?.id, m[name]?.version);
    }
  });
  const lighting = [];
  for (const l of sources) {
    l.updateWorldMatrix(true, false);
    l.target?.updateWorldMatrix(true, false);
    lighting.push(
      l.id,
      l.visible,
      l.intensity,
      l.color.getHex(),
      l.distance,
      l.decay,
      l.angle,
      l.penumbra,
      ...l.matrixWorld.elements,
      ...(l.target?.matrixWorld.elements ?? []),
    );
  }
  return {
    geometry: geometry.join(","),
    surface: surface.join(","),
    lighting: lighting.join(","),
    bindings: bindings.join(","),
  };
}

export function createBaker({ scene, renderer, sky, sun }) {
  let level;
  let sources = [];
  let probes;
  let map;
  let job;
  let reference;
  let stale = null;
  let failure = null;
  let lightKey = "";
  let disposed = false;
  const timing = { probesMs: 0, unwrapMs: 0, mapMs: 0, voxelMs: 0, bakes: 0 };
  const proxy = new THREE.DirectionalLight(0xffffff, 0);
  proxy.name = "sun for baking";
  scene.add(proxy, proxy.target);

  function settle(status) {
    job?.resolve({ status });
    job = null;
  }

  function hideResult() {
    if (probes) probes.intensity = 0;
    for (const [material, saved] of map?.materials ?? []) {
      material.lightMap = saved.lightMap;
      material.lightMapIntensity = saved.intensity;
      material.lightsNode = saved.lightsNode;
      material.needsUpdate = true;
    }
    if (map) map.shown = false;
  }

  function releaseMap() {
    if (!map) return;
    hideResult();
    map.mapper.dispose();
    map.volume.dispose();
    for (const [mesh, saved] of map.geometries) {
      if (mesh.geometry === saved.baked) {
        // unwrapUVs replaced this geometry. If the game subsequently edited that replacement,
        // it now owns those edits: keep it rather than restoring an obsolete pre-bake shape.
        if (geometryKey(saved.baked) !== saved.key) continue;
        mesh.geometry = saved.original;
      }
      saved.baked.dispose();
    }
    map = null;
  }

  function invalidate(reason = "scene changed") {
    if (stale === reason && !job) return;
    stale = reason;
    hideResult();
    settle("stale");
  }

  function capturing(work, voxel = false) {
    const hidden = [];
    const hide = (o) => {
      if (o.visible) {
        hidden.push(o);
        o.visible = false;
      }
    };
    const staticObjects = new Set();
    level.traverse((o) => staticObjects.add(o));
    // Hide renderable objects, not their groups: the level and selected lights may be nested.
    scene.traverse((o) => {
      if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o !== sky && !staticObjects.has(o))
        hide(o);
    });
    // Bake only the explicitly selected fixed lights. Point lights used for gameplay stay live.
    scene.traverse((o) => {
      if (
        o.isLight &&
        o !== probes &&
        o !== proxy &&
        (!sources.includes(o) || (voxel && o === sun))
      )
        hide(o);
    });
    const environment = scene.environment;
    const fog = scene.fog;
    const fogNode = scene.fogNode;
    scene.fog = scene.fogNode = null; // view haze is not indirect illumination
    if (sky.visible) scene.environment = null; // the capture already sees the sky
    try {
      return work();
    } finally {
      scene.environment = environment;
      scene.fog = fog;
      scene.fogNode = fogNode;
      hidden.forEach((o) => (o.visible = true));
    }
  }

  function buildProbes(box) {
    if (probes) {
      scene.remove(probes);
      probes.dispose();
    }
    const size = box.getSize(new THREE.Vector3()).add(new THREE.Vector3(4, 6, 4));
    const centre = box.getCenter(new THREE.Vector3());
    // Floor the counts and bound the product, including the extra vertical padding.
    const spacing = Math.max(2, Math.cbrt((size.x * size.y * size.z) / MAX_PROBES));
    const count = (extent) => Math.max(2, Math.min(24, Math.floor(extent / spacing)));
    const counts = [count(size.x), count(size.y), count(size.z)];
    while (counts[0] * counts[1] * counts[2] > MAX_PROBES) {
      const i = counts.indexOf(Math.max(...counts));
      counts[i] -= 1;
    }
    probes = new LightProbeGrid(size.x, size.y, size.z, ...counts);
    probes.position.copy(centre);
    probes.intensity = 0;
    scene.add(probes);
  }

  function prepareMap() {
    const meshes = [];
    level.traverse((o) => {
      if (o.isMesh) {
        if (
          o.isSkinnedMesh ||
          o.isInstancedMesh ||
          Array.isArray(o.material) ||
          !(o.material.isMeshStandardMaterial || o.material.isMeshStandardNodeMaterial)
        )
          throw new Error(
            "Bake a group of static standard-material meshes; keep other objects outside it.",
          );
        meshes.push(o);
      }
    });
    const levelMaterials = new Set(meshes.map((mesh) => mesh.material));
    scene.traverse((o) => {
      if (o.isMesh && !meshes.includes(o) && [o.material].flat().some((m) => levelMaterials.has(m)))
        throw new Error("Give the baked level its own materials; a moving object shares one.");
    });
    const geometries = new Map(meshes.map((mesh) => [mesh, { original: mesh.geometry }]));
    // Keep material identities: WebGPURenderer accepts node properties on standard materials.
    // The game's references (roughness, color, maps, etc.) continue to control what it sees.
    const materials = new Map(
      meshes.map(({ material }) => [
        material,
        {
          lightMap: material.lightMap,
          intensity: material.lightMapIntensity,
          lightsNode: material.lightsNode,
        },
      ]),
    );
    let volume;
    let mapper;
    try {
      const start = performance.now();
      const atlas = unwrapUVs(level, { resolution: ATLAS, padding: 3 });
      timing.unwrapMs = Math.round(performance.now() - start);
      if (!atlas)
        throw new Error("The level does not fit one light map; use a smaller baked group.");
      for (const [mesh, saved] of geometries) {
        saved.baked = mesh.geometry;
        saved.key = geometryKey(mesh.geometry);
      }
      volume = new VXGIVolume(VOXELS);
      volume.bounds.copy(new THREE.Box3().setFromObject(level).expandByScalar(2));
      mapper = new LightMapper(
        renderer,
        atlas.resolution,
        vxgiIrradiance(volume, { coneCount: 3 }),
      );
      mapper.addObjects(meshes);
      map = { volume, mapper, geometries, materials, shown: false, key: null };
    } catch (error) {
      mapper?.dispose();
      volume?.dispose();
      for (const [mesh, saved] of geometries) {
        if (mesh.geometry !== saved.original) {
          mesh.geometry.dispose();
          mesh.geometry = saved.original;
        }
      }
      throw error;
    }
  }

  function syncLights() {
    if (!map?.shown) return;
    const list = [];
    scene.traverseVisible((o) => {
      if (o.isLight && o !== probes) list.push(o);
    });
    const key = list.map((l) => l.id).join(",");
    if (key === lightKey) return;
    lightKey = key;
    for (const material of map.materials.keys()) {
      material.lightsNode = lights(list);
      material.needsUpdate = true;
    }
    reference = sceneKey(level, sources);
  }

  function step() {
    if (job.stage === "probes") {
      const start = performance.now();
      const total = probes.resolution.x * probes.resolution.y * probes.resolution.z;
      const count = Math.min(PROBES_PER_FRAME, total - job.probe);
      // The second pass captures the first pass's diffuse bounce.
      probes.intensity = job.pass > 0 ? 1 : 0;
      capturing(() =>
        probes.bake(renderer, scene, {
          cubemapSize: 32,
          near: 0.1,
          far: 1000,
          start: job.probe,
          count,
          pass: job.pass,
        }),
      );
      probes.intensity = 0;
      timing.probesMs += performance.now() - start;
      job.probe += count;
      if (job.probe >= total) {
        job.probe = 0;
        job.pass += 1;
      }
      if (job.pass >= 2) job.stage = renderer.backend.isWebGPUBackend ? "voxelize" : "done";
    } else if (job.stage === "voxelize") {
      if (!map) prepareMap();
      const key = sceneKey(level, sources);
      // Reuse voxels for another bake of only the lights. Geometry or baked surface changes
      // invalidate their data too; unchanged geometry also keeps its UV atlas.
      map.volume.needsUpdate =
        !map.key || key.geometry !== map.key.geometry || key.surface !== map.key.surface;
      proxy.color.copy(sun.color);
      proxy.intensity = sources.includes(sun) && sun.visible ? sun.intensity : 0;
      proxy.position.copy(sun.position);
      const start = performance.now();
      try {
        map.volume.lightingNeedsUpdate = true;
        capturing(() => map.volume.update(renderer, scene), true);
      } finally {
        proxy.intensity = 0;
      }
      timing.voxelMs = Math.round(performance.now() - start);
      map.key = key;
      map.mapper.reset();
      job.started = performance.now();
      job.stage = "accumulate";
      reference = sceneKey(level, sources); // unwrapUVs may replace the geometry
    } else if (job.stage === "accumulate") {
      map.mapper.update();
      if (map.mapper.samples >= SAMPLES) {
        for (const material of map.materials.keys()) material.lightMap = map.mapper.texture;
        map.shown = true;
        lightKey = "";
        syncLights();
        reference = sceneKey(level, sources); // our own material update is not an invalidation
        timing.mapMs = Math.round(performance.now() - job.started);
        job.stage = "done";
      }
    }
    if (job.stage === "done") {
      timing.bakes += 1;
      settle("ready");
    }
  }

  return {
    setLevel(object, fixedLights) {
      settle("cancelled");
      releaseMap();
      level = object;
      sources = [...fixedLights];
      reference = null;
      stale = "not baked";
    },
    bake() {
      if (disposed)
        throw new Error("This lighting has been disposed; bake in the current game instead.");
      settle("cancelled");
      const now = sceneKey(level, sources);
      if (map && (now.geometry !== reference?.geometry || now.bindings !== reference?.bindings))
        releaseMap();
      hideResult();
      buildProbes(new THREE.Box3().setFromObject(level));
      reference = sceneKey(level, sources);
      stale = failure = null;
      timing.probesMs = 0;
      return new Promise((resolve) => {
        job = { stage: "probes", probe: 0, pass: 0, resolve };
      });
    },
    invalidate,
    update() {
      if (!level || stale || failure) return;
      const now = sceneKey(level, sources);
      if (
        now.geometry !== reference.geometry ||
        now.surface !== reference.surface ||
        now.lighting !== reference.lighting
      ) {
        invalidate("baked geometry, materials or fixed lights changed");
        return;
      }
      try {
        if (job) step();
        else syncLights();
      } catch (error) {
        failure = String(error?.message ?? error);
        hideResult();
        settle("failed");
        console.warn(`Indirect lighting failed; the scene uses realtime light. ${failure}`);
      }
      if (!job && !stale && !failure) {
        probes.intensity = 1;
        for (const material of map?.materials.keys() ?? []) material.lightMapIntensity = 1;
      }
    },
    stats: () => ({
      phase: failure ? "failed" : stale ? "stale" : (job?.stage ?? (map?.shown ? "map" : "probes")),
      pending: Boolean(job),
      probes: probes ? probes.resolution.x * probes.resolution.y * probes.resolution.z : 0,
      ...timing,
      probesMs: Math.round(timing.probesMs),
      stale,
      failure,
    }),
    dispose() {
      disposed = true;
      settle("cancelled");
      releaseMap();
      probes?.dispose();
      probes?.removeFromParent();
      scene.remove(proxy, proxy.target);
    },
  };
}
