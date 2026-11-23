// The things in the game's world that a person may want to move, tune, copy or swap, and the kinds
// they are made of. Code says how one kind of thing is built and behaves; public/things.json says
// which things there are, where they stand and what their values are. The app's editor changes
// that file while the game runs, and the Agent edits it as any other file: either way the running
// game follows, thing by thing, without starting over.
//
//   public/things.json
//   { "things": [ { "id": "crate-3", "kind": "crate", "name": "Crate 3", "at": [6.4, 0, 6.8],
//                   "yaw": 69, "scale": 1.5, "ground": true, "values": { "breakable": true } } ],
//     "kinds":  { "crate": { "snow": 0.95 } } }
//
//   things.kind("crate", {
//     label: "Crate",                               the name of its group in the editor
//     model: "models/crate.glb",                    placed in each thing's holder (core/assets.js)
//     fields: {                                     what a person may tune, as in core/tuning.js
//       snow: { label: "Snow cover", value: 0.95, min: 0, max: 1, step: 0.05 },
//       breakable: { label: "Breakable", value: false, each: true } },
//     build(thing) { … return { update(delta), dispose() }; },
//   });
//
// A field holds one value for the whole kind, or one for each thing when it says `each: true`.
// build() gets the thing once it stands in the scene:
//
//   thing.object              its holder, a THREE.Group already placed, turned and scaled
//   thing.get("snow")         a field's value now
//   thing.on("snow", fn)      called when that value changes; gone with the thing
//   thing.on("placed", fn)    called when the file moved, turned or resized it (the person in the
//                             editor, or an edit of the file): for what does not follow the holder
//                             by itself, such as a fixed collider or a cached place
//   thing.model               the placement of the kind's model, when it has one
//
//   things.spawn("grunt", { at: [0, 0, -4] })   a thing made while playing: it is in no file, and
//                                               thing.remove() takes it away
//   things.all("crate")  things.find("crate-3")
//   things.ground((x, z) => height)             where the ground is, for things that stand on it
//
// `at` is metres, `yaw` degrees about the vertical, `scale` one number. A thing that also leans
// keeps "turn": [x, y, z] instead of `yaw`, degrees with the vertical in the middle. A thing with
// "ground": true stands on the ground at its x and z, whatever its y says. The runtime builds the
// file's things after createGame() returns and calls each one's update() while the game runs.
// While the game is built, the app's editor reaches the things through `window.__game.things`
// (read, change, undo, redo); a packaged game has no editor and only reads the file.
import * as THREE from "three";
import { placeModel } from "./assets.js";
import { assetUrl } from "./paths.js";
import { applyOps, invertOp, thingsFile, turnOf } from "./things-ops.js";

const SAVE_AFTER_MS = 250;
const UNDO_KEPT = 100;
/** Changes to the same part that follow each other this closely are one change to take back. */
const SAME_CHANGE_MS = 800;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The things of `after` that are new, gone or different from `before`, by id. */
export function diffThings(before, after) {
  const old = new Map(before.map((thing) => [thing.id, thing]));
  const added = [];
  const changed = [];
  for (const thing of after) {
    const was = old.get(thing.id);
    if (!was) {
      added.push(thing);
    } else if (!same(was, thing)) {
      changed.push(thing);
    }
    old.delete(thing.id);
  }
  return { added, changed, removed: [...old.keys()] };
}

export async function loadThings(url = "things.json") {
  let file = thingsFile();
  let base = "";
  let scene;
  let groundAt;
  let serial = 0;
  let revision = 0;
  // What the editor has seen is told by this: a new page is a new one.
  const page = Math.random().toString(36).slice(2, 10);
  const kinds = new Map();
  /** id → the thing as it stands in the scene. */
  const live = new Map();
  /** Called after the file's things changed: some may have been built again or taken away. */
  const watchers = new Set();

  const kindValues = (kind) => file.kinds[kind] ?? {};
  const touch = () => {
    revision++;
  };

  /**
   * Puts a thing's holder where its entry says. With the entry it had (`was`), only the parts the
   * entry changed are put: a thing the game has moved since (a pushed barrel) stays where the game
   * has it when its color or its size changes. Answers whether anything was put.
   */
  function place(thing, was) {
    const { at = [0, 0, 0], scale = 1, ground = false } = thing.entry;
    const moved = !was || !same([was.at, was.ground], [thing.entry.at, thing.entry.ground]);
    const turned = !was || !same(turnOf(was), turnOf(thing.entry));
    const sized = !was || (was.scale ?? 1) !== scale;
    if (moved) {
      const y = ground && groundAt ? groundAt(at[0], at[2]) : at[1];
      thing.object.position.set(at[0], Number.isFinite(y) ? y : at[1], at[2]);
    }
    if (turned) {
      // The facing first, then the lean: a thing turned about the vertical leans the same way.
      const turn = turnOf(thing.entry).map((degrees) => THREE.MathUtils.degToRad(degrees));
      thing.object.rotation.set(...turn, "YXZ");
    }
    if (sized) {
      thing.object.scale.setScalar(scale);
    }
    return moved || turned || sized;
  }

  function build(entry, temporary) {
    const kind = kinds.get(entry.kind);
    const object = new THREE.Group();
    object.name = entry.name || entry.id;
    object.userData.thing = entry.id;
    const listeners = new Map();
    const thing = {
      id: entry.id,
      kind: entry.kind,
      temporary,
      entry,
      object,
      listeners,
      get(field) {
        const declared = kind?.fields?.[field];
        const held = declared?.each ? thing.entry.values?.[field] : kindValues(entry.kind)[field];
        return held ?? declared?.value;
      },
      on(field, listener) {
        const set = listeners.get(field) ?? new Set();
        set.add(listener);
        listeners.set(field, set);
        return () => set.delete(listener);
      },
      remove() {
        if (temporary) {
          drop(entry.id);
        }
      },
    };
    place(thing);
    scene.add(object);
    const model = entry.model ?? kind?.model;
    if (model) {
      thing.model = placeModel(model, object);
    }
    try {
      thing.made = kind?.build?.(thing);
    } catch (error) {
      console.error(`things: building ${entry.id} failed`, error);
    }
    live.set(entry.id, thing);
    touch();
    return thing;
  }

  function drop(id) {
    const thing = live.get(id);
    if (!thing) {
      return;
    }
    live.delete(id);
    try {
      thing.made?.dispose?.();
    } catch (error) {
      console.error(`things: disposing ${id} failed`, error);
    }
    thing.listeners.clear();
    if (thing.model) {
      thing.model.remove();
    }
    thing.object.removeFromParent();
    touch();
  }

  const tell = (thing, field) => {
    for (const listener of thing.listeners.get(field) ?? []) {
      listener(thing.get(field));
    }
  };

  /** Brings one standing thing to what its entry now says, rebuilding only when it must. */
  function follow(thing, entry) {
    const was = thing.entry;
    if (was.kind !== entry.kind || (was.model ?? null) !== (entry.model ?? null)) {
      drop(thing.id);
      build(entry, thing.temporary);
      return;
    }
    thing.entry = entry;
    thing.object.name = entry.name || entry.id;
    if (place(thing, was)) {
      tell(thing, "placed");
    }
    const fields = new Set([...Object.keys(was.values ?? {}), ...Object.keys(entry.values ?? {})]);
    for (const field of fields) {
      if (!same(was.values?.[field], entry.values?.[field])) {
        tell(thing, field);
      }
    }
    touch();
  }

  /** Takes the running game from the file it shows to `next`. */
  function adopt(next) {
    const before = file;
    file = next;
    if (!scene) {
      return;
    }
    const { added, changed, removed } = diffThings(before.things, next.things);
    for (const id of removed) {
      drop(id);
    }
    for (const entry of changed) {
      const thing = live.get(entry.id);
      if (thing) {
        follow(thing, entry);
      }
    }
    for (const entry of added) {
      build(entry, false);
    }
    const names = new Set([...Object.keys(before.kinds), ...Object.keys(next.kinds)]);
    for (const name of names) {
      const was = before.kinds[name] ?? {};
      const now = next.kinds[name] ?? {};
      for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (!same(was[field], now[field])) {
          for (const thing of live.values()) {
            if (thing.kind === name) {
              tell(thing, field);
            }
          }
        }
      }
    }
    touch();
    for (const watcher of watchers) {
      watcher();
    }
  }

  // The editor's changes on their way to the file. While there are any, the file is older than
  // the game: reading it then would put a thing back where it was for a moment, so the file is
  // not read until they are saved. The save is applied to the file as it then is, which may hold
  // an edit of the Agent's made meanwhile, so the file is always read once a save is through.
  let unsent = [];
  let saving = 0;
  // The game shows changes of the editor's that the file read last did not have: the next read
  // is taken whatever the file says, since a change the server refused is in the game and not
  // in a file that reads as it did before.
  let changed = false;
  const ahead = () => unsent.length > 0 || saving > 0;

  /** Reads the file; false when it is the version already shown, or changes are on their way. */
  async function read() {
    if (ahead()) {
      return false;
    }
    try {
      const response = await fetch(`${assetUrl(url)}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) {
        return false;
      }
      const text = await response.text();
      const digest = await sha256(text).catch(() => text);
      if (ahead()) {
        // A change was made while the file was on its way here: its save reads the file again.
        return false;
      }
      if (digest === base && !changed) {
        return false;
      }
      base = digest;
      changed = false;
      adopt(thingsFile(JSON.parse(text)));
      return true;
    } catch {
      return false;
    }
  }
  await read();
  // The Agent edited the file, or the editor's own save came back: the game follows it.
  import.meta.hot?.on("things:changed", () => void read());

  // The editor's changes: applied here at once, sent to the dev server a moment later, and kept
  // as pairs so each can be taken back.
  const undone = [];
  const done = [];
  let timer;
  let failed = false;
  let sending = Promise.resolve();

  async function send() {
    const ops = unsent;
    unsent = [];
    if (!ops.length) {
      return;
    }
    saving++;
    try {
      const response = await fetch("/__meshy/things", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      });
      failed = !response.ok;
    } catch {
      failed = true;
    }
    saving--;
    touch();
    if (!ahead()) {
      // What the file says now is what the game shows: the saved changes, with whatever else was
      // written to it meanwhile, or without a change it refused.
      void read();
    }
  }

  function queue(ops) {
    unsent.push(...ops);
    clearTimeout(timer);
    timer = setTimeout(() => {
      sending = sending.then(send);
    }, SAVE_AFTER_MS);
  }

  /** The one part a single change sets, such as a thing's position, or undefined for any other. */
  function partOf(ops) {
    const [op] = ops;
    if (ops.length !== 1 || (op.op !== "set" && op.op !== "kind")) {
      return undefined;
    }
    const { values, ...rest } = op.op === "set" ? (op.patch ?? {}) : { values: op.values };
    const parts = [...Object.keys(rest), ...Object.keys(values ?? {}).map((name) => `=${name}`)];
    return `${op.op}:${op.id ?? op.kind}:${parts.sort().join(",")}`;
  }

  /** Applies changes to the game now and saves them; false when one of them is refused. */
  function change(ops, { record = true } = {}) {
    let next;
    const back = [];
    try {
      let step = file;
      for (const op of ops) {
        const inverse = invertOp(step, op);
        if (inverse) {
          back.unshift(inverse);
        }
        step = applyOps(step, [op]);
      }
      next = step;
    } catch {
      return false;
    }
    adopt(next);
    changed = true;
    queue(ops);
    if (record) {
      // A slider dragged is one change to take back, not one for each value it passed.
      const part = partOf(ops);
      const last = done.at(-1);
      const now = Date.now();
      if (part && last?.part === part && now - last.at < SAME_CHANGE_MS) {
        last.ops = ops;
        last.at = now;
      } else {
        done.push({ ops, back, part, at: now });
        done.splice(0, done.length - UNDO_KEPT);
      }
      undone.length = 0;
    }
    return true;
  }

  const fieldsOf = (kind) =>
    Object.entries(kind?.fields ?? {}).map(([id, declared]) => ({ id, ...declared }));

  /**
   * The game's side of the app's editor, which the runtime puts at `window.__game.things` while
   * the game is built. Every answer is plain data; the app checks it before drawing from it.
   */
  const panel = {
    /** The kinds and the things as they are now, the file's and the ones made while playing. */
    read(known) {
      const head = {
        revision: `${page}:${revision}`,
        // The last save was refused or never reached the dev server; a change on its way is not one.
        failed,
        undo: done.length,
        redo: undone.length,
      };
      if (known === head.revision) {
        return head;
      }
      return {
        ...head,
        kinds: [...new Set([...kinds.keys(), ...file.things.map((thing) => thing.kind)])].map(
          (name) => ({
            name,
            label: kinds.get(name)?.label ?? name,
            model: kinds.get(name)?.model ?? null,
            known: kinds.has(name),
            fields: fieldsOf(kinds.get(name)),
            values: kindValues(name),
          }),
        ),
        things: [...live.values()].map((thing) => ({
          ...thing.entry,
          name: thing.entry.name ?? thing.id,
          temporary: thing.temporary,
        })),
      };
    },
    /** Changes the file's things: a list of the changes core/things-ops.js describes. */
    change(ops) {
      return change(Array.isArray(ops) ? ops : []);
    },
    undo() {
      const last = done.pop();
      if (!last || !change(last.back, { record: false })) {
        return false;
      }
      undone.push(last);
      return true;
    },
    redo() {
      const last = undone.pop();
      if (!last || !change(last.ops, { record: false })) {
        return false;
      }
      done.push(last);
      return true;
    },
    /** An id no thing has, from a kind's or a model's name: "crate" gives "crate-4". */
    /** An id no thing has, nor any of `chosen`, the ids picked a moment ago in the same change. */
    freeId(stem, chosen = []) {
      const clean =
        String(stem)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "thing";
      const taken = new Set([...file.things.map((thing) => thing.id), ...live.keys(), ...chosen]);
      let number = 1;
      while (taken.has(`${clean}-${number}`)) {
        number++;
      }
      return `${clean}-${number}`;
    },
    /** Resolves once every change made so far has reached the file, or failed to. */
    async settled() {
      clearTimeout(timer);
      sending = sending.then(send);
      await sending;
      return !failed;
    },
  };

  return {
    kind(name, definition = {}) {
      kinds.set(name, definition);
      // Things of a kind that is declared late are built again as that kind.
      for (const thing of [...live.values()]) {
        if (thing.kind === name) {
          drop(thing.id);
          build(thing.entry, thing.temporary);
        }
      }
      touch();
    },
    spawn(kind, entry = {}) {
      const id = entry.id ?? `${kind}~${++serial}`;
      return build({ ...entry, id, kind }, true);
    },
    all(kind) {
      const all = [...live.values()];
      return kind ? all.filter((thing) => thing.kind === kind) : all;
    },
    find(id) {
      return live.get(id);
    },
    /**
     * Calls `watcher` after the file's things changed (an edit, an undo, the Agent's write): one
     * may have been built again or taken away, so what was held of it is looked up again by id.
     */
    watch(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    /** The ground's height at a spot, when the game said where its ground is. */
    height(x, z) {
      const y = groundAt?.(x, z);
      return Number.isFinite(y) ? y : undefined;
    },
    ground(at) {
      groundAt = at;
      for (const thing of live.values()) {
        place(thing);
      }
    },
    /** The thing an object of the scene belongs to, itself or the nearest holder above it. */
    of(object) {
      for (let current = object; current; current = current.parent) {
        if (current.userData?.thing !== undefined) {
          return live.get(current.userData.thing);
        }
      }
      return undefined;
    },
    /** The runtime calls it once createGame() has returned: the file's things take their places. */
    begin() {
      for (const entry of file.things) {
        if (!live.has(entry.id)) {
          build(entry, false);
        }
      }
    },
    update(delta) {
      for (const thing of live.values()) {
        thing.made?.update?.(delta);
      }
    },
    /**
     * Takes every thing and kind away and moves to the scene of the next version of the game,
     * when there is one; the runtime calls it between versions.
     */
    reset(nextScene) {
      for (const id of [...live.keys()]) {
        drop(id);
      }
      kinds.clear();
      scene = nextScene;
      groundAt = undefined;
      touch();
    },
    /** For `window.__game.things`, while the game is built. */
    panel: import.meta.hot ? panel : undefined,
  };
}
