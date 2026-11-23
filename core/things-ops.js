// The changes an editor makes to public/things.json, as data: the page applies them to the running
// game at once and the dev server (core/dev.js) applies the same ones to the file, so what is on
// screen and what is saved cannot drift apart. Nothing here touches a page, a file or three.js.
//
//   { op: "set", id, patch: { name?, at?, yaw?, turn?, scale?, ground?, model?, values? } }
//   { op: "add", thing: { id, kind, name?, at?, yaw?, turn?, scale?, ground?, model?, values? } }
//   { op: "remove", id }
//   { op: "kind", kind, values }        values every thing of a kind shares
//
// In a patch and in `values`, null takes a part or a value away: the thing goes back to what the
// game does without it, or to what its kind declares.
//
// A thing's rotation is `yaw`, degrees about the vertical, while it only faces a way; one that also
// leans keeps `turn`, degrees about x, the vertical and z (the facing first, then the lean), and
// `turn` is the one read when a thing has both.

export const THING_LIMITS = { things: 2000, name: 80, values: 64, text: 200, numbers: 12 };

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FIELD = /^[a-zA-Z][\w.-]{0,63}$/;
const MODEL = /^models\/[\w][\w./-]{0,200}\.(glb|gltf)$/i;
const PATCH_KEYS = new Set(["name", "at", "yaw", "turn", "scale", "ground", "model", "values"]);

export class ThingError extends Error {}

const refuse = (message) => {
  throw new ThingError(message);
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => JSON.parse(JSON.stringify(value));
const triple = (value) => Array.isArray(value) && value.length === 3 && value.every(finite);

/** A thing's rotation in degrees about x, the vertical and z: its `turn`, or its `yaw` alone. */
export const turnOf = (entry) => (triple(entry?.turn) ? entry.turn : [0, entry?.yaw ?? 0, 0]);

/**
 * A rotation as a thing keeps it: `yaw` while it only faces a way, which most things do and is the
 * shorter to read and write, `turn` once it also leans. The other of the two is taken away.
 */
export const turnPatch = ([x, y, z]) =>
  x === 0 && z === 0 ? { yaw: y, turn: null } : { turn: [x, y, z], yaw: null };

function checkValue(key, value, { clearable }) {
  if (value === null && clearable) {
    return;
  }
  const numbers =
    Array.isArray(value) && value.length <= THING_LIMITS.numbers && value.every(finite);
  const text = typeof value === "string" && value.length <= THING_LIMITS.text;
  if (!(typeof value === "boolean" || finite(value) || text || numbers)) {
    refuse(`${key} takes true or false, a number, a short text or a few numbers`);
  }
}

function checkValues(values, options) {
  if (!plain(values) || Object.keys(values).length > THING_LIMITS.values) {
    refuse("values is a small set of named values");
  }
  for (const [key, value] of Object.entries(values)) {
    if (!FIELD.test(key)) {
      refuse(`${key} is not a value's name`);
    }
    checkValue(key, value, options);
  }
}

/** Refuses a part of a thing that is not the kind of value it holds. */
function checkParts(given, { clearable }) {
  // A part set to null is one being taken away.
  const parts = clearable
    ? Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null))
    : given;
  const { name, at, yaw, turn, scale, ground, model, values } = parts;
  if (name !== undefined && (typeof name !== "string" || name.length > THING_LIMITS.name)) {
    refuse(`name is a text of at most ${THING_LIMITS.name} characters`);
  }
  if (at !== undefined && !triple(at)) {
    refuse("at takes three numbers");
  }
  if (turn !== undefined && !triple(turn)) {
    refuse("turn takes three numbers of degrees");
  }
  if (yaw !== undefined && !finite(yaw)) {
    refuse("yaw takes a number of degrees");
  }
  if (scale !== undefined && !(finite(scale) && scale > 0 && scale <= 1000)) {
    refuse("scale takes a number above 0");
  }
  if (ground !== undefined && typeof ground !== "boolean") {
    refuse("ground takes true or false");
  }
  if (model !== undefined && !(typeof model === "string" && MODEL.test(model))) {
    refuse("model is a .glb or .gltf under models/");
  }
  if (model?.includes("..")) {
    refuse("model is a .glb or .gltf under models/");
  }
  if (values !== undefined) {
    checkValues(values, { clearable });
  }
}

function merged(current, values) {
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function applyOp(file, op) {
  if (!plain(op)) {
    refuse("a change is an object");
  }
  const index = (id) => file.things.findIndex((thing) => thing.id === id);
  switch (op.op) {
    case "set": {
      const at = index(op.id);
      if (at < 0) {
        refuse(`no thing ${op.id}`);
      }
      if (!plain(op.patch) || Object.keys(op.patch).some((key) => !PATCH_KEYS.has(key))) {
        refuse("patch changes name, at, yaw, turn, scale, ground, model or values");
      }
      checkParts(op.patch, { clearable: true });
      const { values, ...rest } = op.patch;
      const thing = merged(file.things[at], rest);
      if (values === null) {
        delete thing.values;
      } else if (values) {
        thing.values = merged(thing.values ?? {}, values);
        if (!Object.keys(thing.values).length) {
          delete thing.values;
        }
      }
      file.things[at] = thing;
      return;
    }
    case "add": {
      const thing = op.thing;
      if (!plain(thing) || !ID.test(thing.id ?? "") || !ID.test(thing.kind ?? "")) {
        refuse("a thing has an id and a kind, in lower-case letters, digits, dots and dashes");
      }
      const { id, kind, ...parts } = thing;
      if (Object.keys(parts).some((key) => !PATCH_KEYS.has(key))) {
        refuse("a thing holds name, at, yaw, turn, scale, ground, model and values");
      }
      checkParts(parts, { clearable: false });
      if (index(id) >= 0) {
        refuse(`there is already a thing ${id}`);
      }
      if (file.things.length >= THING_LIMITS.things) {
        refuse(`a game holds at most ${THING_LIMITS.things} things`);
      }
      file.things.push({ id, kind, ...parts });
      return;
    }
    case "remove": {
      const at = index(op.id);
      if (at < 0) {
        refuse(`no thing ${op.id}`);
      }
      file.things.splice(at, 1);
      return;
    }
    case "kind": {
      if (!ID.test(op.kind ?? "")) {
        refuse("kind is a kind's name");
      }
      checkValues(op.values, { clearable: true });
      file.kinds[op.kind] = merged(file.kinds[op.kind] ?? {}, op.values);
      return;
    }
    default:
      refuse("a change sets, adds or removes a thing, or sets a kind's values");
  }
}

/** The file as an object with its two parts in place, whatever was read. */
export function thingsFile(value) {
  const file = plain(value) ? copy(value) : {};
  file.things = Array.isArray(file.things) ? file.things.filter(plain) : [];
  file.kinds = plain(file.kinds) ? file.kinds : {};
  return file;
}

/** The file after the changes, all of them or none: the first one refused throws a ThingError. */
export function applyOps(value, ops) {
  if (!Array.isArray(ops) || ops.length > THING_LIMITS.things) {
    refuse("changes come as a list");
  }
  const file = thingsFile(value);
  for (const op of ops) {
    applyOp(file, op);
  }
  return file;
}

/** The change that takes `op` back, read from the file before it; undefined for one it refuses. */
export function invertOp(value, op) {
  const file = thingsFile(value);
  const thing = file.things.find((entry) => entry.id === (op.id ?? op.thing?.id));
  switch (op.op) {
    case "set": {
      if (!thing || !plain(op.patch)) {
        return undefined;
      }
      const patch = {};
      for (const key of Object.keys(op.patch)) {
        if (key === "values") {
          patch.values = Object.fromEntries(
            Object.keys(op.patch.values ?? {}).map((name) => [name, thing.values?.[name] ?? null]),
          );
        } else {
          patch[key] = thing[key] === undefined ? null : copy(thing[key]);
        }
      }
      return { op: "set", id: op.id, patch };
    }
    case "add":
      return thing ? undefined : { op: "remove", id: op.thing?.id };
    case "remove":
      return thing ? { op: "add", thing: copy(thing) } : undefined;
    case "kind": {
      const current = file.kinds[op.kind] ?? {};
      return {
        op: "kind",
        kind: op.kind,
        values: Object.fromEntries(
          Object.keys(op.values ?? {}).map((name) => [name, current[name] ?? null]),
        ),
      };
    }
    default:
      return undefined;
  }
}
