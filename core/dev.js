// The dev server's side of the template. It runs in Node inside the Vite server the Agent started,
// in the same sandbox as any command, and only while serving: a build never includes it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { applyOps, ThingError } from "./things-ops.js";

const MAX_TUNING_BYTES = 256 * 1024;
const MAX_THINGS_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GLB_SIGNATURE = [0x67, 0x6c, 0x54, 0x46];

/** The public/ path of a changed file, with forward slashes, or undefined outside public/. */
function publicPath(publicDir, file) {
  const path = relative(publicDir, file);
  if (!path || path.startsWith("..") || isAbsolute(path)) {
    return undefined;
  }
  return path.split(sep).join("/");
}

/**
 * Files under public/ that the running game picks up itself, so writing them never reloads the
 * page and loses the game's state: a model written there replaces its placeholder or its older
 * copy (core/assets.js), the tuning file and asset manifest reload, and images written by the
 * tools page reach a 2D game on its next swap.
 */
export function publicFileEvents() {
  return {
    name: "meshy-public-files",
    hotUpdate({ file, timestamp, type }) {
      if (this.environment.name !== "client") {
        return;
      }
      const path = publicPath(this.environment.config.publicDir, file);
      if (!path) {
        return;
      }
      const send = (event) =>
        this.environment.hot.send({
          type: "custom",
          event,
          data: { path, version: timestamp, type },
        });
      if (/^models\/.+\.(glb|gltf)$/i.test(path)) {
        if (type !== "delete") {
          send("model:changed");
        }
        return [];
      }
      if (path === "tuning.json") {
        send("tuning:changed");
        return [];
      }
      if (path === "things.json") {
        send("things:changed");
        return [];
      }
      if (path === "assets.json") {
        send("assets:changed");
        return [];
      }
      if (/^(images|sprites)\//.test(path)) {
        send("image:changed");
        return [];
      }
    },
  };
}

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const digest = (text) => createHash("sha256").update(text).digest("hex");

/** Refuses a number outside the parameter's declared range or off its step. */
function checkNumber(id, param, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeError(422, `${id} takes a number`);
  }
  if (
    (param.min !== undefined && value < param.min) ||
    (param.max !== undefined && value > param.max)
  ) {
    throw new BridgeError(422, `${id} is outside ${param.min} to ${param.max}`);
  }
  if (param.step) {
    const origin = param.min ?? 0;
    const steps = (value - origin) / param.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      throw new BridgeError(422, `${id} is not on its step of ${param.step}`);
    }
  }
}

/** Refuses a value that is not the kind its parameter declares (core/tuning.js lists the kinds). */
function checkValue(id, param, value) {
  if (Array.isArray(param.value)) {
    if (!Array.isArray(value) || value.length !== param.value.length) {
      throw new BridgeError(422, `${id} takes ${param.value.length} numbers`);
    }
    for (const point of value) {
      checkNumber(id, param, point);
    }
  } else if (Array.isArray(param.options)) {
    const choices = param.options.map((option) =>
      option !== null && typeof option === "object" ? option.value : option,
    );
    if (!choices.includes(value)) {
      throw new BridgeError(422, `${id} takes one of its options`);
    }
  } else if (Array.isArray(param.swatches)) {
    const color = typeof value === "string" ? value.toLowerCase() : value;
    if (!param.swatches.some((swatch) => String(swatch).toLowerCase() === color)) {
      throw new BridgeError(422, `${id} takes one of its swatches`);
    }
  } else if (typeof param.value === "boolean") {
    if (typeof value !== "boolean") {
      throw new BridgeError(422, `${id} takes true or false`);
    }
  } else {
    checkNumber(id, param, value);
  }
}

/**
 * Writes the values the tuning panel saves into public/tuning.json. `base` is the digest of the
 * file the panel loaded: a file changed since then (the Agent edited it) refuses the write rather
 * than overwrite that edit. Only `value` fields change, each of the kind its parameter declares:
 * a number within its range and on its step, one of its options or swatches, true or false, or a
 * curve's points.
 */
export function applyTuning(text, base, values) {
  if (digest(text) !== base) {
    throw new BridgeError(409, "tuning.json changed since the panel loaded it");
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BridgeError(422, "tuning.json is not valid JSON");
  }
  const params = new Map((file.params ?? []).map((param) => [param.id, param]));
  for (const [id, value] of Object.entries(values ?? {})) {
    const param = params.get(id);
    if (!param) {
      throw new BridgeError(422, `unknown parameter ${id}`);
    }
    checkValue(id, param, value);
    param.value = value;
  }
  const next = `${JSON.stringify(file, null, 2)}\n`;
  return { text: next, base: digest(next) };
}

const inline = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(inline).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, held]) => `${JSON.stringify(key)}: ${inline(held)}`,
    );
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
};

/** The things file as text: one thing and one kind to a line, so a change is one changed line. */
export function formatThings(file) {
  const { things = [], kinds = {}, ...rest } = file;
  const block = (open, rows, close) =>
    rows.length ? `${open}\n${rows.join(",\n")}\n  ${close}` : `${open}${close}`;
  const parts = [
    `  "things": ${block(
      "[",
      things.map((thing) => `    ${inline(thing)}`),
      "]",
    )}`,
    `  "kinds": ${block(
      "{",
      Object.entries(kinds).map(
        ([name, values]) => `    ${JSON.stringify(name)}: ${inline(values)}`,
      ),
      "}",
    )}`,
    ...Object.entries(rest).map(([key, value]) => `  ${JSON.stringify(key)}: ${inline(value)}`),
  ];
  return `{\n${parts.join(",\n")}\n}\n`;
}

/**
 * Writes the editor's changes into public/things.json. Each change names its thing, so it is
 * applied to the file as it is now, the Agent's latest edit included, and none of them is written
 * unless all of them hold (core/things-ops.js). A game without the file gets one.
 */
export function applyThings(text, ops) {
  let file;
  try {
    file = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new BridgeError(422, "things.json is not valid JSON");
  }
  let next;
  try {
    next = applyOps(file, ops);
  } catch (error) {
    if (error instanceof ThingError) {
      throw new BridgeError(422, error.message);
    }
    throw error;
  }
  const written = formatThings(next);
  if (Buffer.byteLength(written) > MAX_THINGS_BYTES) {
    throw new BridgeError(413, "things.json would be too large");
  }
  return { text: written, base: digest(written) };
}

/**
 * Where a file the tools page made goes, by a plain relative path under public/: a PNG under
 * images/ or sprites/, a sprite sheet's JSON atlas under sprites/, or a GLB under models/.
 */
export function assetTarget(publicDir, path) {
  const parts = String(path ?? "").split("/");
  const plain =
    parts.length >= 2 &&
    parts.every((part) => part && !part.startsWith(".") && !/[\\:]/.test(part));
  const valid =
    plain &&
    (((parts[0] === "images" || parts[0] === "sprites") && /\.png$/i.test(path)) ||
      (parts[0] === "sprites" && /\.json$/i.test(path)) ||
      (parts[0] === "models" && /\.glb$/i.test(path)));
  if (!valid) {
    throw new BridgeError(
      422,
      "path must be images/….png, sprites/….png or .json, or models/….glb",
    );
  }
  return join(publicDir, ...parts);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BridgeError(413, "the upload is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BridgeError(422, "the body is not valid JSON");
  }
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** The panel's save and the tools page's files, written into this game's public/ folder. */
export function devBridge() {
  return {
    name: "meshy-dev-bridge",
    apply: "serve",
    configureServer(server) {
      const publicDir = server.config.publicDir;
      const handle = (work) => async (req, res) => {
        if (req.method !== "POST") {
          reply(res, 405, { error: "POST only" });
          return;
        }
        try {
          reply(res, 200, await work(req));
        } catch (error) {
          reply(res, error instanceof BridgeError ? error.status : 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      server.middlewares.use(
        "/__meshy/tuning",
        handle(async (req) => {
          const { base, values } = parseJson(await readBody(req, MAX_TUNING_BYTES));
          const file = join(publicDir, "tuning.json");
          const next = applyTuning(await readFile(file, "utf8"), base, values);
          await writeFile(file, next.text);
          return { base: next.base };
        }),
      );
      // One write at a time: each reads the file the one before it wrote.
      let writing = Promise.resolve();
      server.middlewares.use(
        "/__meshy/things",
        handle(async (req) => {
          const { ops } = parseJson(await readBody(req, MAX_THINGS_BYTES));
          const file = join(publicDir, "things.json");
          const run = writing.then(async () => {
            const text = await readFile(file, "utf8").catch(() => "");
            const next = applyThings(text, ops);
            await writeFile(file, next.text);
            return { base: next.base };
          });
          writing = run.catch(() => {});
          return run;
        }),
      );
      server.middlewares.use(
        "/__meshy/file",
        handle(async (req) => {
          const path = new URL(req.url ?? "", "http://localhost").searchParams.get("path");
          const target = assetTarget(publicDir, path);
          const model = /\.glb$/i.test(target);
          const bytes = await readBody(req, model ? MAX_MODEL_BYTES : MAX_IMAGE_BYTES);
          if (
            /\.png$/i.test(target) &&
            !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
          ) {
            throw new BridgeError(422, "the body is not a PNG");
          }
          if (model && !GLB_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
            throw new BridgeError(422, "the body is not a GLB");
          }
          if (/\.json$/i.test(target)) {
            parseJson(bytes);
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          return { path };
        }),
      );
    },
  };
}
