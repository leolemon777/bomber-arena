// Models in the running game. A model is placed by its path under public/ before the file exists:
// a placeholder of its manifest size stands in, and the model takes its place when the file is
// written (a generation's out), position and all, without reloading the page. Writing the file
// again replaces it the same way.
//
//   const car = placeModel("models/car.glb", scene);   car.holder is in the scene at once
//   car.holder.position.set(0, 0, 5);                  move the holder, never the model inside
//   const { model, animations } = await car.ready;     resolves when the real model is in
//   const copy = cloneModel(model);                     a second rigged character (own skeleton)
//
// Each file loads once. Before the game starts, behind the loading screen, the runtime loads every
// model in the manifest that is on disk, except those marked "preload": false, and a new version
// of the game places them again from memory. A model first needed later (a later level, a rare
// event) is marked so and loaded before it appears, so it shows no placeholder either:
//
//   await loadModels(["models/boss.glb"]);             then placeModel puts it in at once
//
// public/assets.json describes each model in the game's terms, and every placement applies it:
//   { "assets": [ { "path": "models/car.glb", "size": 4.2, "measure": "length",
//                   "forward": "+z", "role": "player", "collision": "dynamic",
//                   "task": "<task_id>", "status": "ready" } ] }
// size is metres along measure (height, length or width); forward is the axis the model's front
// faces in the file (+z, -z, +x, -x), turned to +z, the direction the game's objects face; the
// model then stands on y = 0, centred on its holder. "preload": false leaves it out of the start's
// wait.
//
// A packaged game (the meshy-game-packaging Skill's build) adds to an entry what the build knows:
// "hash", the file's content, asked for with the address so the file can be cached for good, and
// "textures", the full textures of a model whose file carries small ones. The start then waits
// only for the small file; after the first frame settleModels() puts the full textures into the
// ones already on screen, then loads the models marked "preload": false. While the game is built
// no entry has either, and every file is read as it is.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { assetUrl, carried } from "./paths.js";

// A model compressed with meshopt (EXT_meshopt_compression) loads like any other.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/** path → the placements of that model in the running game. */
const placed = new Map();
/**
 * path → the loaded file ({ version, scene, animations }); every placement is a copy of it. A
 * packaged game's opening version also keeps `sources`, its textures' images by their place in
 * the file, until the full textures are in.
 */
const loaded = new Map();
/** path → the load in flight ({ version, promise }). */
const loading = new Map();
let manifest;
/** The manifest's entries once read, for placing a loaded model without waiting. */
let entries = new Map();

export async function loadManifest() {
  if (!manifest) {
    // A packaged game's page carries the manifest; while the game is built the file is read.
    const inPage = carried("game-assets");
    manifest = (
      inPage
        ? Promise.resolve(inPage)
        : fetch(`${assetUrl("assets.json")}?v=${Date.now()}`, { cache: "no-store" }).then(
            (response) => (response.ok ? response.json() : { assets: [] }),
          )
    )
      .then((file) => new Map((file.assets ?? []).map((entry) => [entry.path, entry])))
      .catch(() => new Map())
      .then((map) => {
        entries = map;
        return map;
      });
  }
  return manifest;
}

const FORWARD_YAW = { "+z": 0, "-z": Math.PI, "+x": -Math.PI / 2, "-x": Math.PI / 2 };

/**
 * Turns, scales and grounds a loaded model in place: its front to +z, its `measure` to `size`
 * metres, its lowest point on y = 0 and its footprint centred. Returns the scale applied.
 */
export function normalizeModel(model, entry = {}) {
  model.rotation.y = FORWARD_YAW[entry.forward ?? "+z"] ?? 0;
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(model);
  const extent = box.getSize(new THREE.Vector3());
  const measured = { height: extent.y, length: extent.z, width: extent.x }[
    entry.measure ?? "height"
  ];
  const scale = entry.size && measured > 0 ? entry.size / measured : 1;
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(model);
  const centre = box.getCenter(new THREE.Vector3());
  model.position.set(-centre.x, -box.min.y, -centre.z);
  return scale;
}

function placeholderFor(entry) {
  // The grey box is for building, when a model is still being generated. A packaged game shows
  // nothing for a model still on its way.
  if (!import.meta.hot) {
    return new THREE.Group();
  }
  const size = entry?.size ?? 1;
  const extent =
    entry?.measure === "length"
      ? [size * 0.5, size * 0.4, size]
      : entry?.measure === "width"
        ? [size, size * 0.5, size * 0.5]
        : [size * 0.4, size, size * 0.4];
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...extent),
    new THREE.MeshStandardMaterial({ color: "#a3a9b0", roughness: 0.9 }),
  );
  mesh.position.y = extent[1] / 2;
  mesh.name = "placeholder";
  return mesh;
}

/** The textures a material uses. */
function texturesOf(material) {
  return Object.values(material).filter((value) => value?.isTexture);
}

/** Marks a loaded file's geometry, materials and textures as shared by every copy placed from it. */
function markShared(scene) {
  scene.traverse((child) => {
    if (child.geometry) {
      child.geometry.userData.shared = true;
    }
    for (const material of [child.material].flat()) {
      if (material) {
        material.userData.shared = true;
        for (const texture of texturesOf(material)) {
          texture.userData.shared = true;
        }
      }
    }
  });
}

/**
 * Frees what `object` and its children hold on the GPU: geometry, materials and their textures,
 * skeletons and lights' shadow maps. What a loaded model file shares between its copies stays,
 * so the next version of the game places it again without loading it.
 */
export function disposeObject(object, { shared = false } = {}) {
  const free = (resource) => {
    if (resource && (shared || !resource.userData?.shared)) {
      resource.dispose();
    }
  };
  object.traverse((child) => {
    free(child.geometry);
    for (const material of [child.material].flat()) {
      if (material) {
        for (const texture of texturesOf(material)) {
          free(texture);
        }
        free(material);
      }
    }
    child.skeleton?.dispose();
    if (child.isLight) {
      child.dispose();
    }
  });
}

/** Loads the file at `path` once (again for a new `version`) and keeps it for every placement. */
function loadFile(path, { version, onProgress } = {}) {
  const current = loaded.get(path);
  if (current && (version === undefined || current.version === version)) {
    return Promise.resolve(current);
  }
  const pending = loading.get(path);
  if (pending && pending.version === version) {
    return pending.promise;
  }
  // A rewritten file is asked for by its version; a packaged game's file by its content's hash.
  const stamp = version ?? entries.get(path)?.hash;
  const url = `${assetUrl(path)}${stamp ? `?v=${stamp}` : ""}`;
  const promise = loader.loadAsync(url, onProgress).then(
    (gltf) => {
      const file = { version, scene: gltf.scene, animations: gltf.animations };
      if (version === undefined && entries.get(path)?.textures?.some(Boolean)) {
        file.sources = imageSources(gltf);
      }
      markShared(file.scene);
      // A load overtaken by a newer write of the same file does not replace it in memory.
      if (loading.get(path)?.promise === promise) {
        loaded.set(path, file);
        loading.delete(path);
      }
      return file;
    },
    (error) => {
      if (loading.get(path)?.promise === promise) {
        loading.delete(path);
      }
      throw error;
    },
  );
  loading.set(path, { version, promise });
  return promise;
}

/** Paths whose failed load was already reported, so each says so once per file written. */
const reported = new Set();

/**
 * Reports a model that failed to load although its file exists, on the console, where the page's
 * errors reach the Agent. A file not written yet (a model still being generated) stays quiet: the
 * dev server answers it with the page itself.
 */
async function reportFailure(path, error) {
  if (reported.has(path)) {
    return;
  }
  const response = await fetch(assetUrl(path), { method: "HEAD", cache: "no-store" }).catch(
    () => undefined,
  );
  if (!response?.ok || response.headers.get("content-type")?.includes("text/html")) {
    return;
  }
  reported.add(path);
  console.error(`Model ${path} did not load: ${error?.message ?? error}`);
}

/** Puts a copy of the loaded `file` into the placement, in place of what it held. */
function put(placement, file) {
  const model = cloneSkinned(file.scene);
  normalizeModel(model, entries.get(placement.path));
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  for (const child of [...placement.holder.children]) {
    placement.holder.remove(child);
    disposeObject(child);
  }
  placement.holder.add(model);
  const replacing = Boolean(placement.model);
  placement.model = model;
  placement.animations = file.animations;
  const result = { model, animations: file.animations };
  if (replacing) {
    placement.onReplace?.(result);
  }
  placement.settle(result);
  return result;
}

/**
 * Loads the models at `paths` (under public/) for placing without a placeholder, reporting
 * progress from 0 to 1; a model still being generated (no file yet) is skipped.
 */
export async function loadModels(paths, onProgress) {
  await loadManifest();
  const unique = [...new Set(paths)];
  if (unique.length === 0) {
    onProgress?.(1);
    return;
  }
  const shares = new Map(unique.map((path) => [path, 0]));
  const report = () =>
    onProgress?.([...shares.values()].reduce((sum, share) => sum + share, 0) / unique.length);
  await Promise.all(
    unique.map((path) =>
      loadFile(path, {
        onProgress: (event) => {
          if (event.lengthComputable && event.total > 0) {
            shares.set(path, event.loaded / event.total);
            report();
          }
        },
      })
        .catch((error) => reportFailure(path, error))
        .finally(() => {
          shares.set(path, 1);
          report();
        }),
    ),
  );
}

/**
 * Loads every model in the manifest that the start waits for (all but those marked
 * "preload": false). The runtime runs it before the game starts.
 */
export async function preloadModels(onProgress) {
  const manifestEntries = await loadManifest();
  const paths = [...manifestEntries.values()]
    .filter((entry) => /\.(glb|gltf)$/i.test(entry.path) && entry.preload !== false)
    .map((entry) => entry.path);
  await loadModels(paths, onProgress);
}

/**
 * Puts the model at `path` (under public/) into `parent`. Returns at once with its holder: a model
 * already loaded is in it at once; otherwise it holds a placeholder until the file loads. `ready`
 * resolves with the model and its animations. `onReplace` runs each time a newer file replaces the
 * model (rebind a mixer there).
 */
export function placeModel(path, parent, { onReplace } = {}) {
  const holder = new THREE.Group();
  holder.name = path;
  parent.add(holder);
  let settle;
  const ready = new Promise((resolve) => {
    settle = resolve;
  });
  const placement = { path, holder, onReplace, settle };
  placed.set(path, [...(placed.get(path) ?? []), placement]);
  const file = loaded.get(path);
  if (file) {
    put(placement, file);
  } else {
    void loadManifest().then((manifestEntries) => {
      if (!placement.model) {
        holder.add(placeholderFor(manifestEntries.get(path)));
      }
    });
    // A missing file is not an error: the model is still being generated, and its arrival replaces
    // the placeholder through the model:changed event below. A file that exists and fails is
    // reported.
    loadManifest()
      .then(() => loadFile(path))
      .then(
        (loadedFile) => !placement.model && put(placement, loadedFile),
        (error) => reportFailure(path, error),
      );
  }
  return {
    holder,
    ready,
    remove() {
      parent.remove(holder);
      disposeObject(holder);
      placed.set(
        path,
        (placed.get(path) ?? []).filter((entry) => entry !== placement),
      );
    },
  };
}

/** Each image of a loaded file, by its place in the file, as the texture source three made of it. */
function imageSources(gltf) {
  const sources = new Map();
  const definitions = gltf.parser.json.textures ?? [];
  for (const [texture, reference] of gltf.parser.associations) {
    const definition = texture?.isTexture ? definitions[reference?.textures] : undefined;
    const image = definition?.extensions?.EXT_texture_webp?.source ?? definition?.source;
    if (image !== undefined) {
      sources.set(image, texture.source);
    }
  }
  return sources;
}

/** The image at `url`, decoded the way the model loader decoded the one it replaces. */
async function fetchImage(url, like) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const blob = await response.blob();
  if (typeof ImageBitmap !== "undefined" && like instanceof ImageBitmap) {
    return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  }
  const image = new Image();
  image.src = URL.createObjectURL(blob);
  try {
    await image.decode();
  } finally {
    URL.revokeObjectURL(image.src);
  }
  return image;
}

/**
 * Puts a loaded file's full textures into the textures already on screen. The image inside each
 * texture is replaced; the model is not loaded a second time, which would make new skeletons and
 * stop every character already animated. Every texture that shows an image is let go of first:
 * the image's size changes, and the renderer keeps a texture's storage at the size it first had.
 */
async function sharpen(path, file) {
  const full = entries.get(path)?.textures ?? [];
  const sources = file.sources;
  file.sources = undefined;
  const textures = new Set();
  file.scene.traverse((child) => {
    for (const material of [child.material].flat()) {
      for (const texture of material ? texturesOf(material) : []) {
        textures.add(texture);
      }
    }
  });
  for (const [index, source] of sources ?? []) {
    if (!full[index]) {
      continue;
    }
    try {
      const image = await fetchImage(assetUrl(full[index]), source.data);
      // A newer file took this one's place while the image was on its way.
      if (loaded.get(path) !== file) {
        image.close?.();
        return;
      }
      const showing = [...textures].filter((texture) => texture.source === source);
      for (const texture of showing) {
        texture.dispose();
      }
      source.data?.close?.();
      source.data = image;
      for (const texture of showing) {
        texture.needsUpdate = true;
      }
    } catch (error) {
      console.error(`Texture ${full[index]} of ${path} did not load: ${error?.message ?? error}`);
    }
  }
}

/**
 * What a packaged game does after its first frame, in this order: the full textures of the models
 * the start waited for, then the models marked "preload": false, so one first shown later is
 * already there. While the game is built there is nothing to do: no entry has a hash, its files
 * are read as they are, and a model for later loads when the game asks for it.
 */
export async function settleModels() {
  const manifestEntries = await loadManifest();
  for (const [path, file] of [...loaded]) {
    if (file.sources) {
      await sharpen(path, file);
    }
  }
  for (const entry of manifestEntries.values()) {
    if (/\.(glb|gltf)$/i.test(entry.path) && entry.preload === false && entry.hash) {
      await loadFile(entry.path).catch((error) => reportFailure(entry.path, error));
    }
  }
}

/** A copy of a loaded model with its own skeleton, for a second character from one file. */
export function cloneModel(model) {
  return cloneSkinned(model);
}

/** Forgets every placement; the runtime calls it between game versions. Loaded files stay. */
export function clearPlacements() {
  placed.clear();
}

// A written model file loads at once, so the game can place it without a placeholder, and replaces
// the copies already placed; the previous file's GPU resources go once nothing shows them.
import.meta.hot?.on("model:changed", async ({ path, version }) => {
  reported.delete(path);
  const previous = loaded.get(path);
  try {
    await loadManifest();
    const file = await loadFile(path, { version });
    for (const placement of placed.get(path) ?? []) {
      put(placement, file);
    }
    if (previous && previous !== file) {
      disposeObject(previous.scene, { shared: true });
    }
  } catch (error) {
    console.error(error);
  }
});

// A changed manifest (a size or a front corrected) applies to the models already in the game, from
// memory: the files are not loaded again.
import.meta.hot?.on("assets:changed", async () => {
  manifest = undefined;
  const manifestEntries = await loadManifest();
  for (const [path, placements] of placed) {
    for (const placement of placements) {
      if (placement.model) {
        normalizeModel(placement.model, manifestEntries.get(path));
      } else {
        for (const child of [...placement.holder.children]) {
          placement.holder.remove(child);
          disposeObject(child);
        }
        placement.holder.add(placeholderFor(manifestEntries.get(path)));
      }
    }
  }
});
