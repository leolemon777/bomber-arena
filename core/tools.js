// Asset tools that run in the browser beside the game, on the same dev server. Open
// /core/tools.html with `browser`, then `evaluate` a call; each writes its result into public/
// through the dev server and returns what it wrote.
//
//   await tools.cutout({ src: "/art/raw/hero.png", out: "images/hero.png" })
//     Removes a flat background: generate the image on one solid color (magenta #ff00ff or green
//     #00ff00, never a color in the subject). key "auto" reads it from the image's border.
//
//   await tools.bake({ model: "/models/hero-run.glb", clip: "run", out: "sprites/hero-run",
//                      directions: 8, frames: 10, size: 128, camera: "iso",
//                      pixel: { size: 48, colors: 16, outline: true } })
//     Renders an animated model into a sprite sheet (one row per direction, one column per frame,
//     transparent background) plus a Phaser JSON atlas: sprites/hero-run.png and .json. Frames are
//     named <clip>_<direction>_<frame>; direction 0 faces the camera, the rest go round clockwise.
//
//   await tools.gifSheet({ src: "/art/raw/hero-walk.gif", out: "sprites/hero-walk", clip: "walk",
//                          size: 192 })
//     Turns an animated GIF into a sprite sheet with real transparency plus a Phaser JSON atlas:
//     sprites/hero-walk.png and .json. The flat background is keyed out as in cutout: key "auto"
//     reads it from the first frame's border and leaves a GIF that is already transparent as it
//     is, "none" keeps it, "#rrggbb" names it. Every frame keeps one crop, the box of the whole
//     motion, at most `size` pixels on its longest edge (left out, the GIF's own size). Frames are
//     named <clip>_0_<frame> (clip defaults to out's file name), in a grid in reading order, each
//     with its duration in milliseconds.
//
//   await tools.shrink({ model: "/models/hero.glb", out: "models/hero.glb", maxSize: 1024,
//                        faces: 100000 })
//     Re-exports a model with its textures at most maxSize pixels on their longest edge, keeping
//     its meshes, skeleton and clips. faces, when given, reduces its triangles to about that many
//     in all by rewriting the index alone: texture coordinates, normals, skin weights and every
//     texture map (the normal map too) stay as they were, and texture seams and hard edges stay
//     closed. A model cut into many small texture islands (a remeshed one) can stop above the
//     count; the result's faces says where. A file outside the game's folder (a detailed model in
//     $MESHY_WORK) is read as /@fs
//     followed by its absolute path. Writing over the same path swaps it in the running game.
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { MeshoptSimplifier } from "three/addons/libs/meshopt_simplifier.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const status = globalThis.document?.getElementById("status");
const preview = globalThis.document?.getElementById("preview");
const say = (text) => {
  if (status) {
    status.textContent = text;
  }
};

/** Paths the dev server has announced since they were written: from then on it serves them. */
const announced = new Map();
for (const event of ["image:changed", "model:changed"]) {
  import.meta.hot?.on(event, ({ path }) => {
    announced.get(path)?.();
    announced.delete(path);
  });
}

async function write(path, blob) {
  const served = new Promise((resolve) => {
    announced.set(path, resolve);
    setTimeout(resolve, 3000);
  });
  const response = await fetch(`/__meshy/file?path=${encodeURIComponent(path)}`, {
    method: "POST",
    body: blob,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    announced.delete(path);
    throw new Error(body.error ?? `writing ${path} failed (${response.status})`);
  }
  await served;
  return path;
}

const toBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );

function show(canvas) {
  if (!preview) {
    return;
  }
  preview.width = canvas.width;
  preview.height = canvas.height;
  preview.getContext("2d").drawImage(canvas, 0, 0);
}

/** The median color of the image's border, taken as the background to remove. */
export function borderColor(data, width, height) {
  const channels = [[], [], []];
  const sample = (x, y) => {
    const index = (y * width + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      channels[c].push(data[index + c]);
    }
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }
  return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
}

/** `#rrggbb` as [r, g, b]. */
const hexColor = (key) =>
  [0, 2, 4].map((offset) => parseInt(key.replace("#", "").slice(offset, offset + 2), 16));

/**
 * The background color to key out of an animation's frame: the border's color, or undefined
 * when most of the border is already transparent and there is nothing to remove.
 */
export function backgroundKey(data, width, height) {
  let clear = 0;
  const count = (x, y) => {
    if (data[(y * width + x) * 4 + 3] < 128) {
      clear += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    count(x, 0);
    count(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    count(0, y);
    count(width - 1, y);
  }
  return clear > width + height ? undefined : borderColor(data, width, height);
}

/**
 * Keys `key` out of RGBA `data` (width × height) in place. Pixels close to the key become
 * transparent. Along the subject's edge, where anti-aliasing mixed the subject with the key, each
 * pixel's alpha is how far it lies from the key toward the nearby solid subject color, and the
 * key's share is taken back out of its color, so no colored fringe remains.
 */
export function keyOut(data, width, height, key, { tolerance = 0.12, band = 2, reach = 4 } = {}) {
  const span = Math.sqrt(3) * 255;
  const count = width * height;
  // 0 background, 1 edge band, 2 solid subject.
  const kind = new Uint8Array(count);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const index = pixel * 4;
    const distance =
      Math.hypot(data[index] - key[0], data[index + 1] - key[1], data[index + 2] - key[2]) / span;
    kind[pixel] = distance < tolerance ? 0 : 2;
  }
  const solid = kind.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (solid[y * width + x] !== 2) {
        continue;
      }
      search: for (let dy = -band; dy <= band; dy += 1) {
        for (let dx = -band; dx <= band; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && solid[ny * width + nx] === 0) {
            kind[y * width + x] = 1;
            break search;
          }
        }
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      if (kind[pixel] === 0) {
        data[index + 3] = 0;
        continue;
      }
      if (kind[pixel] === 2) {
        continue;
      }
      // The subject color this edge pixel fades from: the mean of solid pixels around it.
      const subject = [0, 0, 0];
      let found = 0;
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && kind[ny * width + nx] === 2) {
            const other = (ny * width + nx) * 4;
            subject[0] += data[other];
            subject[1] += data[other + 1];
            subject[2] += data[other + 2];
            found += 1;
          }
        }
      }
      if (!found) {
        continue;
      }
      const toSubject = subject.map((sum, c) => sum / found - key[c]);
      const toPixel = [0, 1, 2].map((c) => data[index + c] - key[c]);
      const length = toSubject[0] ** 2 + toSubject[1] ** 2 + toSubject[2] ** 2;
      const alpha = Math.min(
        Math.max(
          length
            ? (toPixel[0] * toSubject[0] + toPixel[1] * toSubject[1] + toPixel[2] * toSubject[2]) /
                length
            : 1,
          0,
        ),
        1,
      );
      if (alpha < 0.02) {
        data[index + 3] = 0;
        continue;
      }
      for (let c = 0; c < 3; c += 1) {
        data[index + c] = Math.min(
          255,
          Math.max(0, Math.round((data[index + c] - (1 - alpha) * key[c]) / alpha)),
        );
      }
      data[index + 3] = Math.round(alpha * data[index + 3]);
    }
  }
}

/** The box of the pixels that are not transparent, inclusive, or undefined when there are none. */
export function opaqueBounds(data, width, height) {
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 4) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0 ? undefined : { left, top, right, bottom };
}

/** `bounds` grown by `padding` on every side, within width × height. */
const pad = ({ left, top, right, bottom }, padding, width, height) => ({
  left: Math.max(0, left - padding),
  top: Math.max(0, top - padding),
  right: Math.min(width - 1, right + padding),
  bottom: Math.min(height - 1, bottom + padding),
});

function trim(canvas, padding) {
  const context = canvas.getContext("2d");
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const bounds = opaqueBounds(data, width, height);
  if (!bounds) {
    return canvas;
  }
  const { left, top, right, bottom } = pad(bounds, padding, width, height);
  const out = document.createElement("canvas");
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out
    .getContext("2d")
    .drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function cutout({ src, out, key = "auto", tolerance = 0.12, crop = true, padding = 2 }) {
  say(`Removing the background of ${src}`);
  const bitmap = await createImageBitmap(await (await fetch(src, { cache: "no-store" })).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const color =
    key === "auto" ? borderColor(image.data, canvas.width, canvas.height) : hexColor(key);
  keyOut(image.data, canvas.width, canvas.height, color, { tolerance });
  context.putImageData(image, 0, 0);
  const result = crop ? trim(canvas, padding) : canvas;
  show(result);
  await write(out, await toBlob(result));
  say(`Wrote ${out}`);
  return { out, width: result.width, height: result.height, key: color };
}

/** Up to `count` colors that represent `pixels` (k-means, seeded from the most common colors). */
export function palette(pixels, count) {
  const buckets = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) {
      continue;
    }
    const key =
      ((pixels[index] >> 3) << 10) | ((pixels[index + 1] >> 3) << 5) | (pixels[index + 2] >> 3);
    const bucket = buckets.get(key) ?? [0, 0, 0, 0];
    bucket[0] += pixels[index];
    bucket[1] += pixels[index + 1];
    bucket[2] += pixels[index + 2];
    bucket[3] += 1;
    buckets.set(key, bucket);
  }
  const colors = [...buckets.values()].map(([r, g, b, n]) => ({ rgb: [r / n, g / n, b / n], n }));
  colors.sort((a, b) => b.n - a.n);
  let centres = colors.slice(0, count).map((entry) => [...entry.rgb]);
  for (let round = 0; round < 8 && centres.length; round += 1) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const { rgb, n } of colors) {
      const nearest = nearestIndex(centres, rgb);
      sums[nearest][0] += rgb[0] * n;
      sums[nearest][1] += rgb[1] * n;
      sums[nearest][2] += rgb[2] * n;
      sums[nearest][3] += n;
    }
    centres = sums.map((sum, index) =>
      sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : centres[index],
    );
  }
  return centres.map((rgb) => rgb.map(Math.round));
}

function nearestIndex(centres, rgb) {
  let best = 0;
  let bestDistance = Infinity;
  centres.forEach((centre, index) => {
    const distance =
      (centre[0] - rgb[0]) ** 2 + (centre[1] - rgb[1]) ** 2 + (centre[2] - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Pixel art from a rendered frame: hard alpha, the sheet's shared palette, an optional outline. */
function pixelate(frame, { size, colours: colors, outline }) {
  const scale = size / Math.max(frame.width, frame.height);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(frame.width * scale));
  small.height = Math.max(1, Math.round(frame.height * scale));
  const context = small.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(frame, 0, 0, small.width, small.height);
  const image = context.getImageData(0, 0, small.width, small.height);
  const { data, width, height } = image;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 128) {
      data[index + 3] = 0;
      continue;
    }
    data[index + 3] = 255;
    const nearest = colors[nearestIndex(colors, [data[index], data[index + 1], data[index + 2]])];
    data[index] = nearest[0];
    data[index + 1] = nearest[1];
    data[index + 2] = nearest[2];
  }
  if (outline) {
    const darkest = colors.reduce((a, b) => (a[0] + a[1] + a[2] <= b[0] + b[1] + b[2] ? a : b));
    const solid = (x, y) =>
      x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] === 255;
    const edges = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (
          !solid(x, y) &&
          (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))
        ) {
          edges.push((y * width + x) * 4);
        }
      }
    }
    for (const index of edges) {
      data[index] = darkest[0];
      data[index + 1] = darkest[1];
      data[index + 2] = darkest[2];
      data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return small;
}

const ELEVATION = { side: 0, iso: 30, top: 89 };

async function bake({
  model,
  out,
  clip: clipName,
  directions = 1,
  frames = 8,
  size = 128,
  camera: view = "side",
  pixel,
}) {
  say(`Baking ${model}`);
  const gltf = await new GLTFLoader().loadAsync(`${model}?v=${Date.now()}`);
  const root = gltf.scene;
  const clip =
    (clipName && gltf.animations.find((entry) => entry.name === clipName)) ?? gltf.animations[0];
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#ffffff", "#6b6f78", 1.6));
  const sun = new THREE.DirectionalLight("#ffffff", 2.2);
  sun.position.set(2, 4, 3);
  scene.add(sun, root);
  const mixer = new THREE.AnimationMixer(root);
  const action = clip ? mixer.clipAction(clip).play() : undefined;
  const duration = clip?.duration ?? 0;

  // Frame the whole motion: the box of every sampled pose, so no frame is clipped.
  const box = new THREE.Box3();
  for (let index = 0; index < frames; index += 1) {
    mixer.setTime((duration * index) / frames);
    root.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(root));
  }
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // The same renderer as the game. Each frame is copied off the canvas in the task that drew it,
  // before the browser presents it, so no readback is needed.
  const renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  const lens = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 10);
  const elevation = THREE.MathUtils.degToRad(ELEVATION[view] ?? 0);

  const rendered = [];
  for (let direction = 0; direction < directions; direction += 1) {
    const azimuth = (direction / directions) * Math.PI * 2;
    lens.position.set(
      centre.x + Math.sin(azimuth) * Math.cos(elevation) * radius * 4,
      centre.y + Math.sin(elevation) * radius * 4,
      centre.z + Math.cos(azimuth) * Math.cos(elevation) * radius * 4,
    );
    lens.lookAt(centre);
    for (let index = 0; index < frames; index += 1) {
      mixer.setTime((duration * index) / frames);
      renderer.render(scene, lens);
      const frame = document.createElement("canvas");
      frame.width = size;
      frame.height = size;
      frame.getContext("2d").drawImage(renderer.domElement, 0, 0);
      rendered.push({ direction, index, frame });
      say(
        `Baking ${model}: direction ${direction + 1}/${directions}, frame ${index + 1}/${frames}`,
      );
    }
  }
  action?.stop();
  renderer.dispose();

  let cells = rendered;
  if (pixel) {
    const sample = document.createElement("canvas");
    sample.width = size;
    sample.height = size * rendered.length;
    rendered.forEach(({ frame }, row) => sample.getContext("2d").drawImage(frame, 0, row * size));
    const pixels = sample.getContext("2d").getImageData(0, 0, sample.width, sample.height).data;
    const colors = palette(pixels, pixel.colors ?? 16);
    cells = rendered.map((cell) => ({
      ...cell,
      frame: pixelate(cell.frame, {
        size: pixel.size ?? 48,
        colours: colors,
        outline: pixel.outline,
      }),
    }));
  }
  const cell = cells[0].frame.width;
  const sheet = document.createElement("canvas");
  sheet.width = cell * frames;
  sheet.height = cell * directions;
  const context = sheet.getContext("2d");
  const atlas = {
    frames: {},
    meta: {
      image: `${out.split("/").at(-1)}.png`,
      size: { w: sheet.width, h: sheet.height },
      scale: "1",
      frameWidth: cell,
      frameHeight: cell,
      directions,
      framesPerDirection: frames,
      duration,
    },
  };
  for (const { direction, index, frame } of cells) {
    context.drawImage(frame, index * cell, direction * cell);
    atlas.frames[`${clip?.name ?? "pose"}_${direction}_${index}`] = {
      frame: { x: index * cell, y: direction * cell, w: cell, h: cell },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cell, h: cell },
      sourceSize: { w: cell, h: cell },
    };
  }
  show(sheet);
  await write(`${out}.png`, await toBlob(sheet));
  await write(
    `${out}.json`,
    new Blob([JSON.stringify(atlas, null, 2)], { type: "application/json" }),
  );
  say(`Wrote ${out}.png and ${out}.json`);
  return { png: `${out}.png`, atlas: `${out}.json`, frameSize: cell, directions, frames, duration };
}

/** A frame's duration in milliseconds; 10 ms or less plays as 100 ms, as browsers play GIFs. */
export function frameDuration(microseconds) {
  const milliseconds = Math.round((microseconds ?? 0) / 1000);
  return milliseconds > 10 ? milliseconds : 100;
}

/**
 * The sheet of `durations.length` frames of one size, in a grid in reading order as near square as
 * it goes, and its Phaser JSON atlas in tools.bake's form with one direction. Each frame carries
 * its duration in milliseconds; `meta.duration` is the whole loop in seconds, as bake's.
 */
export function sheetAtlas({ clip, image, durations, cellWidth, cellHeight }) {
  const columns = Math.ceil(Math.sqrt(durations.length));
  const rows = Math.ceil(durations.length / columns);
  const frames = {};
  const positions = durations.map((duration, index) => {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    frames[`${clip}_0_${index}`] = {
      frame: { x, y, w: cellWidth, h: cellHeight },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cellWidth, h: cellHeight },
      sourceSize: { w: cellWidth, h: cellHeight },
      duration,
    };
    return { x, y };
  });
  const atlas = {
    frames,
    meta: {
      image,
      size: { w: columns * cellWidth, h: rows * cellHeight },
      scale: "1",
      frameWidth: cellWidth,
      frameHeight: cellHeight,
      directions: 1,
      framesPerDirection: durations.length,
      duration: durations.reduce((sum, duration) => sum + duration, 0) / 1000,
    },
  };
  return { atlas, columns, positions };
}

const GIF_SIGNATURE = /^GIF8[79]a$/;

/**
 * Every frame of a GIF as a canvas of the whole picture, and its duration. Chromium's decoder
 * composites each frame over the ones before it as the file's disposal says.
 */
async function decodeFrames(src) {
  if (!globalThis.ImageDecoder) {
    throw new Error("this browser has no ImageDecoder to read the GIF's frames");
  }
  const response = await fetch(src, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || !GIF_SIGNATURE.test(String.fromCharCode(...bytes.subarray(0, 6)))) {
    throw new Error(`${src} is not a GIF in this game's folder`);
  }
  const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const frames = [];
    for (let index = 0; index < decoder.tracks.selectedTrack.frameCount; index += 1) {
      const { image } = await decoder.decode({ frameIndex: index });
      const canvas = document.createElement("canvas");
      canvas.width = image.displayWidth;
      canvas.height = image.displayHeight;
      canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
      frames.push({ canvas, duration: frameDuration(image.duration) });
      image.close();
    }
    return frames;
  } finally {
    decoder.close();
  }
}

/** The color `key` names for a frame: none, the border's ("auto") or `#rrggbb`. */
function keyColor(key, data, width, height) {
  if (key === "none") {
    return undefined;
  }
  return key === "auto" ? backgroundKey(data, width, height) : hexColor(key);
}

async function gifSheet({
  src,
  out,
  clip = out.split("/").at(-1),
  key = "auto",
  tolerance = 0.12,
  size,
  padding = 2,
}) {
  say(`Reading the frames of ${src}`);
  const frames = await decodeFrames(src);
  const { width, height } = frames[0].canvas;
  const images = frames.map(({ canvas }) =>
    canvas.getContext("2d").getImageData(0, 0, width, height),
  );
  const color = keyColor(key, images[0].data, width, height);
  // One crop for every frame, the box of the whole motion, so the subject keeps its place.
  let box;
  frames.forEach(({ canvas }, index) => {
    const image = images[index];
    if (color) {
      keyOut(image.data, width, height, color, { tolerance });
      canvas.getContext("2d").putImageData(image, 0, 0);
    }
    const bounds = opaqueBounds(image.data, width, height);
    if (bounds) {
      box = box
        ? {
            left: Math.min(box.left, bounds.left),
            top: Math.min(box.top, bounds.top),
            right: Math.max(box.right, bounds.right),
            bottom: Math.max(box.bottom, bounds.bottom),
          }
        : bounds;
    }
    say(`Keying ${src}: frame ${index + 1}/${frames.length}`);
  });
  if (!box) {
    throw new Error(`nothing is left of ${src} once its background is removed; pass key "none"`);
  }
  const { left, top, right, bottom } = pad(box, padding, width, height);
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const scale = size ? Math.min(1, size / Math.max(cropWidth, cropHeight)) : 1;
  const cellWidth = Math.max(1, Math.round(cropWidth * scale));
  const cellHeight = Math.max(1, Math.round(cropHeight * scale));
  const durations = frames.map((frame) => frame.duration);
  const { atlas, columns, positions } = sheetAtlas({
    clip,
    image: `${out.split("/").at(-1)}.png`,
    durations,
    cellWidth,
    cellHeight,
  });
  const sheet = document.createElement("canvas");
  sheet.width = atlas.meta.size.w;
  sheet.height = atlas.meta.size.h;
  const context = sheet.getContext("2d");
  context.imageSmoothingQuality = "high";
  frames.forEach(({ canvas }, index) => {
    const { x, y } = positions[index];
    context.drawImage(canvas, left, top, cropWidth, cropHeight, x, y, cellWidth, cellHeight);
  });
  show(sheet);
  await write(`${out}.png`, await toBlob(sheet));
  await write(
    `${out}.json`,
    new Blob([JSON.stringify(atlas, null, 2)], { type: "application/json" }),
  );
  say(`Wrote ${out}.png and ${out}.json`);
  return {
    png: `${out}.png`,
    atlas: `${out}.json`,
    clip,
    frames: frames.length,
    frameWidth: cellWidth,
    frameHeight: cellHeight,
    columns,
    durations,
    duration: atlas.meta.duration,
    key: color ?? "none",
  };
}

/** The longest edge of every texture in `object`, largest first. */
function textureSizes(object) {
  const sizes = new Set();
  object.traverse((child) => {
    for (const material of [child.material].flat()) {
      for (const value of Object.values(material ?? {})) {
        if (value?.isTexture && value.image) {
          sizes.add(Math.max(value.image.width ?? 0, value.image.height ?? 0));
        }
      }
    }
  });
  return [...sizes].sort((a, b) => b - a);
}

/** A copy of `attribute` holding only the vertices `remap` keeps, at their new places. */
function keptVertices(attribute, remap, count) {
  const size = attribute.itemSize;
  const interleaved = attribute.isInterleavedBufferAttribute;
  const source = interleaved ? attribute.data.array : attribute.array;
  const stride = interleaved ? attribute.data.stride : size;
  const offset = interleaved ? attribute.offset : 0;
  const array = new source.constructor(count * size);
  for (let vertex = 0; vertex < remap.length; vertex++) {
    const to = remap[vertex];
    if (to === 0xffffffff) {
      continue;
    }
    for (let component = 0; component < size; component++) {
      array[to * size + component] = source[vertex * stride + offset + component];
    }
  }
  return new THREE.BufferAttribute(array, size, attribute.normalized);
}

/**
 * A mesh's positions as the simplifier reads them, each coordinate on a grid a millionth of the
 * mesh's size. The simplifier joins copies of a vertex only when their positions are equal, and
 * a generator can write a seam's two copies a rounding error apart (sin 2π is not 0): on the grid
 * they meet. The mesh keeps its own positions.
 */
function simplifierPositions(geometry) {
  const position = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const step = Math.max(size.x, size.y, size.z) / 2 ** 20 || 1;
  const positions = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex++) {
    positions[vertex * 3] = Math.round(position.getX(vertex) / step) * step;
    positions[vertex * 3 + 1] = Math.round(position.getY(vertex) / step) * step;
    positions[vertex * 3 + 2] = Math.round(position.getZ(vertex) / step) * step;
  }
  return positions;
}

/**
 * Reduces the triangles of the meshes under `object` to about `faces` in all, each mesh keeping
 * its share. Only the index is rewritten: every vertex that stays keeps its position, normal,
 * texture coordinates and skin weights, so the texture maps and the skeleton still fit, and the
 * vertices glTF splits along texture seams and hard edges move together instead of tearing
 * apart. Vertices no triangle uses any more are dropped. `error` is the largest deviation, as a
 * share of a mesh's size.
 */
export async function reduceFaces(object, faces) {
  await MeshoptSimplifier.ready;
  const geometries = new Set();
  object.traverse((child) => {
    if (child.isMesh && child.geometry.index) {
      geometries.add(child.geometry);
    }
  });
  const triangles = (geometry) => geometry.index.count / 3;
  const before = [...geometries].reduce((sum, geometry) => sum + triangles(geometry), 0);
  let after = 0;
  let error = 0;
  for (const geometry of geometries) {
    const own = triangles(geometry);
    const target = Math.max(1, Math.round((own * faces) / before));
    if (target >= own) {
      after += own;
      continue;
    }
    // An error bound of 1 (the mesh's whole size) lets the count, which the caller chose, decide.
    const [indices, meshError] = MeshoptSimplifier.simplify(
      Uint32Array.from(geometry.index.array),
      simplifierPositions(geometry),
      3,
      target * 3,
      1,
    );
    const [remap, count] = MeshoptSimplifier.compactMesh(indices);
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      geometry.setAttribute(name, keptVertices(attribute, remap, count));
    }
    for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
      geometry.morphAttributes[name] = targets.map((morph) => keptVertices(morph, remap, count));
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    after += indices.length / 3;
    error = Math.max(error, meshError);
  }
  return { before, after, error };
}

async function shrink({ model, out, maxSize = 1024, faces }) {
  if (faces !== undefined && !(Number.isInteger(faces) && faces > 0)) {
    throw new Error("faces is a whole number of triangles; leave it out to keep every face");
  }
  say(
    faces
      ? `Reducing ${model} to ${faces} faces and its textures to ${maxSize} px`
      : `Shrinking the textures of ${model} to ${maxSize} px`,
  );
  const gltf = await new GLTFLoader().loadAsync(`${model}?v=${Date.now()}`);
  const before = textureSizes(gltf.scene);
  const reduced = faces === undefined ? undefined : await reduceFaces(gltf.scene, faces);
  const glb = await new GLTFExporter().parseAsync(gltf.scene, {
    binary: true,
    animations: gltf.animations,
    maxTextureSize: maxSize,
  });
  await write(out, new Blob([glb], { type: "model/gltf-binary" }));
  say(`Wrote ${out}`);
  return {
    out,
    bytes: glb.byteLength,
    texturesBefore: before,
    maxSize,
    ...(reduced && {
      facesBefore: reduced.before,
      faces: reduced.after,
      error: Number(reduced.error.toPrecision(2)),
    }),
    clips: gltf.animations.map((clip) => clip.name),
  };
}

if (globalThis.window) {
  window.tools = { cutout, bake, gifSheet, shrink };
  say("Ready");
}
