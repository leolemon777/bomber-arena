// The values that shape how the game plays, from public/tuning.json, and the game's side of the
// panel the person tunes them in. The app draws that panel beside the game from this file: what
// each value is decides its control, `panel` arranges them, `takes` are whole feels to compare.
// The file is read with fetch rather than imported: writing it never reloads the page.
//
//   public/tuning.json
//   { "params": [
//       { "id": "player.jump", "label": "Jump height", "value": 2.4, "min": 1, "max": 4, "step": 0.1,
//         "unit": "m", "applies": "next" },                                        a slider
//       { "id": "aim.assist", "label": "Aim assist", "value": true },              a switch
//       { "id": "sky", "label": "Sky", "value": "dusk",
//         "options": [{ "value": "day", "label": "Day" }, { "value": "dusk", "label": "Dusk" }] },
//       { "id": "coin.color", "label": "Coins", "value": "#ffd34d",
//         "swatches": ["#ffd34d", "#7cc7ff", "#ff8a5c"] },                         colors to pick
//       { "id": "spawn.rate", "label": "Enemies a minute", "value": [10, 20, 40, 60],
//         "min": 0, "max": 100, "step": 5, "from": "Start", "to": "Minute 3" } ],  a curve
//     "panel": [
//       { "title": "Jump", "items": ["player.jump", { "readout": "jump.last", "label": "Last jump" }] },
//       { "title": "Difficulty", "folded": true, "columns": 2,
//         "items": ["spawn.rate", { "action": "skip", "label": "Start at wave 5" }] } ],
//     "takes": [ { "name": "Snappy", "values": { "player.jump": 2 } } ] }
//
//   tuning.get("player.jump")          the current value (the panel's, before it is saved)
//   tuning.on("player.jump", fn)       called when that value changes; returns an off()
//   tuning.report("jump.last", "1.8 m")  what a readout of the panel shows
//   tuning.action("skip", fn)          what a button of the panel does; returns an off()
//
// "applies": "next" marks a value the game reads when a run starts; the panel says so. Without
// `panel`, the values are listed under their `group`.
//
// The panel is for building the game: its changes apply at once, Save writes the file through the
// dev server (core/dev.js), Reset goes back to what the file says. A packaged game has no panel,
// and reads the values its page carries instead of the file.
import { assetUrl, carried } from "./paths.js";

const MAX_READOUT_CHARS = 40;

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const same = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : a === b;

/** Whether a value the panel sends is the kind its parameter holds; the dev server checks ranges. */
function fits(param, value) {
  if (Array.isArray(param.value)) {
    return (
      Array.isArray(value) &&
      value.length === param.value.length &&
      value.every((item) => Number.isFinite(item))
    );
  }
  return (
    typeof value === typeof param.value && (typeof value !== "number" || Number.isFinite(value))
  );
}

export async function loadTuning(url = "tuning.json") {
  const inPage = carried("game-tuning");
  let file = { params: [] };
  let base = "";
  // What the panel has seen is told by this: a new page, or the file read again, is a new one.
  const page = Math.random().toString(36).slice(2, 10);
  let reads = 0;
  const values = new Map();
  const listeners = new Map();
  const actions = new Map();
  const readouts = new Map();
  const asked = new Set();

  const set = (id, value) => {
    if (same(values.get(id), value)) {
      return;
    }
    values.set(id, value);
    for (const listener of listeners.get(id) ?? []) {
      listener(value);
    }
  };
  /** Reads the file; false when it is the version already loaded (or the panel's own save). */
  const read = async () => {
    try {
      if (inPage) {
        // A packaged game's values came with its page: no file to read, compare or save, and no
        // hashing, which a page served without HTTPS cannot do.
        if (base) {
          return false;
        }
        file = inPage;
        base = "page";
      } else {
        const response = await fetch(`${assetUrl(url)}?v=${Date.now()}`, { cache: "no-store" });
        const text = await response.text();
        const digest = await sha256(text);
        if (digest === base) {
          return false;
        }
        file = JSON.parse(text);
        base = digest;
      }
    } catch {
      file = { params: [] };
      base = "";
    }
    reads++;
    for (const param of file.params ?? []) {
      set(param.id, param.value);
    }
    return true;
  };
  await read();

  // The Agent edited the file: the game takes its values, and the panel is drawn again from it.
  import.meta.hot?.on("tuning:changed", () => void read());

  const revision = () => `${page}:${reads}`;
  /** Posts the values as they are now; what was sent is what the file then says. */
  const write = async () => {
    const sent = Object.fromEntries(values);
    let response;
    try {
      response = await fetch("/__meshy/tuning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base, values: sent }),
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, reason: response.status === 409 ? "changed" : "refused" };
    }
    // The file now says what was sent; its own change event finds nothing new to read.
    base = body.base;
    for (const param of file.params ?? []) {
      if (Object.hasOwn(sent, param.id)) {
        param.value = sent[param.id];
      }
    }
    reads++;
    return { ok: true };
  };
  let saving = Promise.resolve();
  /**
   * The game's side of the app's panel, which the runtime puts at `window.__game.tuning`. Every
   * answer is plain data; the app checks it before drawing anything from it.
   */
  const panel = {
    /**
     * What the panel shows now: the readouts and the buttons the game answers, and, when `known`
     * is not this revision, the file with the current values. `unused` lists the values the game
     * has not asked for since it started.
     */
    read(known) {
      const params = file.params ?? [];
      return {
        revision: revision(),
        readouts: Object.fromEntries(readouts),
        actions: [...actions.keys()],
        unused: params.map((param) => param.id).filter((id) => !asked.has(id)),
        ...(known === revision() ? {} : { file, values: Object.fromEntries(values) }),
      };
    },
    /** Takes the values the person set, each of the kind its parameter holds. */
    set(next) {
      const params = new Map((file.params ?? []).map((param) => [param.id, param]));
      for (const [id, value] of Object.entries(next ?? {})) {
        const param = params.get(id);
        if (param && fits(param, value)) {
          set(id, Array.isArray(value) ? [...value] : value);
        }
      }
      return true;
    },
    /**
     * Writes the current values into the file through the dev server, one save after another: a
     * second one sent meanwhile would carry the file's old digest and be refused.
     */
    save() {
      const run = saving.then(write);
      saving = run.catch(() => {});
      return run;
    },
    /** Goes back to what the file says. */
    async reset() {
      base = "";
      await read();
      return true;
    },
    /** Runs a button's action; false when the game has none by that name. */
    act(name) {
      const run = actions.get(name);
      if (!run) {
        return false;
      }
      run();
      return true;
    },
  };

  return {
    get(id) {
      asked.add(id);
      return values.get(id);
    },
    on(id, listener) {
      asked.add(id);
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    /** Shows a short text in the panel's readout of that name: a number the person tunes by. */
    report(name, value) {
      readouts.set(name, String(value).slice(0, MAX_READOUT_CHARS));
    },
    /** What the panel's button of that name does. */
    action(name, run) {
      actions.set(name, run);
      return () => {
        if (actions.get(name) === run) {
          actions.delete(name);
        }
      };
    },
    /** Drops what a game version registered; the runtime calls it between versions. */
    clearListeners() {
      listeners.clear();
      actions.clear();
      readouts.clear();
      asked.clear();
    },
    /** For `window.__game.tuning`; a packaged game has none. */
    panel: inPage ? undefined : panel,
  };
}
