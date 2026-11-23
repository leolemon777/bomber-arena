// Actions bound to keys, mouse buttons, the first gamepad and touch, read once per frame.
//
//   input.down("jump")         held now
//   input.pressed("jump")      went down since the last frame (a tap shorter than a frame counts)
//   input.released("jump")     went up since the last frame
//   input.axis("left", "right") -1…1, a stick included for the four directions
//   input.vector()             { x, y } from left, right, down and up (y toward up), length at
//                              most 1: moving diagonally is no faster; a stick included
//   input.look()               { x, y }: how far to turn the view this frame, in radians at normal
//                              sensitivity (x to the right, y up), from the mouse while the pointer
//                              is locked, a finger dragged over the look area and the gamepad's
//                              right stick
//   input.touch({ move, look, buttons })   the controls a touch screen shows (below)
//   input.mode                 "keys" or "touch": what the person plays with now; <html data-input>
//                              says the same, so a HUD shows the hints for one and hides the other's
//   input.bind({ jump: ["Space", "PadA"] })   replaces those actions' bindings
//
// Keys are KeyboardEvent.code values ("KeyW", "ArrowUp", "Space"), mouse buttons "Mouse0" to
// "Mouse2", gamepad buttons "PadA", "PadB", "PadX", "PadY", "PadL", "PadR", "PadStart",
// "PadSelect", "PadUp", "PadDown", "PadLeft", "PadRight". One code belongs to one action: binding
// it to a second one throws, since a key that does two things reads as a bug to the player.
// Losing focus (the person clicks the chat beside the game) lets go of every key and never pauses.
//
// On a touch screen the game is played with controls over it (core/touch.js draws them), declared
// once in createGame:
//
//   input.touch({ move: true, look: false, buttons: [{ action: "jump", label: "Jump" }] })
//
//   move     a stick where the left thumb lands, read through axis(), vector() and down("left")…
//   look     dragging over the right half (all of it without move) turns the view: look()
//   buttons  up to four actions under the right thumb, the first the largest, each held while a
//            finger is on it; a pause button joins them while "pause" is bound
//
// They show while the person plays by touch (from the start on a phone, else from the first touch)
// and hide at a mouse click; keys never hide them. A tap anywhere else reaches the game as pointer
// events and as Mouse0, and the game's own .hit elements in #ui lie above the controls.

import { createTouchLayer } from "./touch.js";

export const DEFAULT_BINDINGS = {
  up: ["KeyW", "ArrowUp", "PadUp"],
  down: ["KeyS", "ArrowDown", "PadDown"],
  left: ["KeyA", "ArrowLeft", "PadLeft"],
  right: ["KeyD", "ArrowRight", "PadRight"],
  action: ["Space", "PadA"],
  pause: ["Escape", "KeyP", "PadStart"],
};

const PAD_BUTTONS = {
  PadA: 0,
  PadB: 1,
  PadX: 2,
  PadY: 3,
  PadL: 4,
  PadR: 5,
  PadSelect: 8,
  PadStart: 9,
  PadUp: 12,
  PadDown: 13,
  PadLeft: 14,
  PadRight: 15,
};
const STICK_DEAD_ZONE = 0.25;
/** How far the touch stick's thumb travels from where it landed to reach full tilt (CSS px). */
export const TOUCH_STICK_RADIUS = 56;
/** A thumb this close to where it landed moves nothing, so a resting thumb does not drift. */
const TOUCH_DEAD_ZONE = 0.12;
/** Past this tilt the stick also holds that direction's action, as an arrow key would. */
const TOUCH_DIRECTION = 0.5;
/** Radians a locked mouse turns the view per pixel, a finger per CSS px, a full stick per second. */
const MOUSE_TURN = 0.0022;
const TOUCH_TURN = 0.008;
const PAD_TURN = 3;
/** The most buttons one thumb reaches without looking. */
const TOUCH_BUTTONS = 4;
const TOUCH_SCREEN = "(hover: none) and (pointer: coarse)";

/** Checks that no code is bound to two actions; returns code → action. */
export function codeMap(bindings) {
  const map = new Map();
  for (const [action, codes] of Object.entries(bindings)) {
    for (const code of codes) {
      const other = map.get(code);
      if (other && other !== action) {
        throw new Error(`${code} is bound to both ${other} and ${action}`);
      }
      map.set(code, action);
    }
  }
  return map;
}

/** A round dead zone, rescaled so the tilt rises from 0 at its edge; length at most 1. */
function deadZone(x, y, zone) {
  const length = Math.hypot(x, y);
  const scale = length > zone ? Math.min((length - zone) / (1 - zone), 1) / length : 0;
  return { x: x * scale, y: y * scale };
}

/** Checks what input.touch() was given; returns it with its defaults. */
function touchLayout({ move = true, look = false, buttons = [] } = {}) {
  if (!Array.isArray(buttons) || buttons.length > TOUCH_BUTTONS) {
    throw new Error(`input.touch takes at most ${TOUCH_BUTTONS} buttons`);
  }
  const actions = new Set();
  for (const button of buttons) {
    if (typeof button?.action !== "string" || !button.action) {
      throw new Error("each input.touch button names its action");
    }
    if (actions.has(button.action)) {
      throw new Error(`input.touch has two buttons for ${button.action}`);
    }
    actions.add(button.action);
  }
  return {
    move: Boolean(move),
    look: Boolean(look),
    buttons: buttons.map(({ action, label }) => ({ action, label: String(label ?? action) })),
  };
}

export function createInput({ target = window, bindings = DEFAULT_BINDINGS, turning } = {}) {
  let actions = { ...bindings };
  let codes = codeMap(actions);
  const held = new Set();
  // Codes that went down since the last frame: a tap released before the frame reads it (a
  // trackpad click, a quick key) still counts as one press.
  const tapped = new Set();
  let now = new Set();
  let before = new Set();
  // Actions held from the keyboard, mouse, gamepad buttons and touch buttons, without what a stick
  // adds: axis() and vector() read a stick's tilt instead of its directions.
  let digital = new Set();
  let stick = { x: 0, y: 0 };
  let look = { x: 0, y: 0 };
  let turned = { x: 0, y: 0 };
  let lastUpdate;

  // Touch: each finger keeps the part it landed on until it lifts.
  const fingers = new Map();
  const touchHeld = new Set();
  const touchTapped = new Set();
  let touchStick = null;
  let layout = null;
  const screen = globalThis.matchMedia?.(TOUCH_SCREEN);
  let mode = screen?.matches ? "touch" : "keys";
  let layer = null;

  const showMode = () => {
    const root = globalThis.document?.documentElement;
    if (root) {
      root.dataset.input = mode;
    }
    layer?.show(mode === "touch");
  };
  const releaseFinger = (id) => {
    const finger = fingers.get(id);
    fingers.delete(id);
    if (finger?.part === "move") {
      touchStick = null;
      layer?.stick(null);
    } else if (finger?.part === "button") {
      touchHeld.delete(finger.action);
      layer?.press(finger.action, false);
    }
  };

  const setMode = (next) => {
    if (mode === next) {
      return;
    }
    mode = next;
    // Controls put away let go of whatever a finger still held on them.
    if (mode === "keys") {
      for (const id of [...fingers.keys()]) {
        releaseFinger(id);
      }
    }
    showMode();
  };
  showMode();

  const onKey = (down) => (event) => {
    const field = event.target?.closest?.("input, textarea, select, [contenteditable]");
    if (!codes.has(event.code) || (down && field)) {
      return;
    }
    // Keep the page from scrolling on Space and the arrows while a game has them.
    event.preventDefault();
    if (down) {
      held.add(event.code);
      tapped.add(event.code);
    } else {
      held.delete(event.code);
    }
  };
  const onMouse = (down) => (event) => {
    const code = `Mouse${event.button}`;
    if (down) {
      held.add(code);
      tapped.add(code);
    } else {
      held.delete(code);
    }
  };
  const onMouseMove = (event) => {
    if (globalThis.document?.pointerLockElement) {
      turned.x += (event.movementX ?? 0) * MOUSE_TURN;
      turned.y -= (event.movementY ?? 0) * MOUSE_TURN;
    }
  };
  const onPointerDown = (event) => {
    if (event.pointerType === "mouse") {
      setMode("keys");
      return;
    }
    setMode("touch");
    const spot = event.target?.closest?.("[data-touch]");
    const part = spot?.dataset?.touch;
    const point = { x: event.clientX, y: event.clientY };
    if (part === "move") {
      const origin = layer?.place(point) ?? point;
      fingers.set(event.pointerId, { part, origin });
      touchStick = { x: 0, y: 0 };
      layer?.stick(origin, origin);
    } else if (part === "look") {
      fingers.set(event.pointerId, { part, last: point });
    } else if (part === "button" && spot.dataset.action) {
      const action = spot.dataset.action;
      fingers.set(event.pointerId, { part, action });
      touchHeld.add(action);
      touchTapped.add(action);
      layer?.press(action, true);
    }
  };
  const onPointerMove = (event) => {
    const finger = fingers.get(event.pointerId);
    if (finger?.part === "move") {
      const dx = (event.clientX - finger.origin.x) / TOUCH_STICK_RADIUS;
      const dy = (event.clientY - finger.origin.y) / TOUCH_STICK_RADIUS;
      touchStick = deadZone(dx, dy, TOUCH_DEAD_ZONE);
      const reach = Math.min(Math.hypot(dx, dy), 1) / (Math.hypot(dx, dy) || 1);
      layer?.stick(finger.origin, {
        x: finger.origin.x + dx * reach * TOUCH_STICK_RADIUS,
        y: finger.origin.y + dy * reach * TOUCH_STICK_RADIUS,
      });
    } else if (finger?.part === "look") {
      turned.x += (event.clientX - finger.last.x) * TOUCH_TURN;
      turned.y -= (event.clientY - finger.last.y) * TOUCH_TURN;
      finger.last = { x: event.clientX, y: event.clientY };
    }
  };
  const onPointerUp = (event) => releaseFinger(event.pointerId);
  const clear = () => {
    held.clear();
    tapped.clear();
    touchTapped.clear();
    for (const id of [...fingers.keys()]) {
      releaseFinger(id);
    }
    turned = { x: 0, y: 0 };
  };
  const onVisibility = () => document.hidden && clear();
  // The screen changed under the page (the app's phone screen turned on or off).
  const onScreen = () => setMode(screen.matches ? "touch" : "keys");
  const listeners = [
    ["keydown", onKey(true)],
    ["keyup", onKey(false)],
    ["mousedown", onMouse(true)],
    ["mouseup", onMouse(false)],
    ["mousemove", onMouseMove],
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerUp],
    ["blur", clear],
  ];
  for (const [type, listener] of listeners) {
    target.addEventListener(type, listener);
  }
  globalThis.document?.addEventListener("visibilitychange", onVisibility);
  screen?.addEventListener?.("change", onScreen);

  const pollPad = () => {
    const pad = globalThis.navigator?.getGamepads?.().find(Boolean);
    const buttons = new Set();
    let padStick = { x: 0, y: 0 };
    let padLook = { x: 0, y: 0 };
    if (pad) {
      for (const [code, index] of Object.entries(PAD_BUTTONS)) {
        if (pad.buttons[index]?.pressed) {
          buttons.add(code);
        }
      }
      // Diagonals do not snap to an axis and speed does not jump.
      const [x = 0, y = 0, lookX = 0, lookY = 0] = pad.axes;
      padStick = deadZone(x, y, STICK_DEAD_ZONE);
      padLook = deadZone(lookX, lookY, STICK_DEAD_ZONE);
    }
    return { buttons, padStick, padLook };
  };
  const activeActions = (pad) => {
    const active = new Set(touchHeld);
    for (const action of touchTapped) {
      active.add(action);
    }
    for (const code of [...held, ...tapped, ...pad]) {
      const action = codes.get(code);
      if (action) {
        active.add(action);
      }
    }
    return active;
  };
  /** The four directions a tilted touch stick holds, as arrow keys would. */
  const stickDirections = () => {
    const directions = new Set();
    if (touchStick) {
      if (touchStick.x <= -TOUCH_DIRECTION) directions.add("left");
      if (touchStick.x >= TOUCH_DIRECTION) directions.add("right");
      if (touchStick.y <= -TOUCH_DIRECTION) directions.add("up");
      if (touchStick.y >= TOUCH_DIRECTION) directions.add("down");
    }
    return directions;
  };

  return {
    /** Reads the devices; the runtime calls it once at the start of every frame. */
    update() {
      const time = globalThis.performance?.now() ?? Date.now();
      const seconds = lastUpdate === undefined ? 0 : Math.min((time - lastUpdate) / 1000, 0.1);
      lastUpdate = time;
      const { buttons, padStick, padLook } = pollPad();
      before = now;
      digital = activeActions(buttons);
      // A thumb on the touch stick is the stick; otherwise the gamepad's.
      stick = touchStick ?? padStick;
      now = new Set([...digital, ...stickDirections()]);
      look = {
        x: turned.x + padLook.x * PAD_TURN * seconds,
        y: turned.y - padLook.y * PAD_TURN * seconds,
      };
      turned = { x: 0, y: 0 };
      tapped.clear();
      touchTapped.clear();
    },
    down: (action) => now.has(action),
    pressed: (action) => now.has(action) && !before.has(action),
    released: (action) => !now.has(action) && before.has(action),
    axis(negative, positive) {
      const keys = (digital.has(positive) ? 1 : 0) - (digital.has(negative) ? 1 : 0);
      if (keys !== 0) {
        return keys;
      }
      if (negative === "left" && positive === "right") {
        return stick.x;
      }
      if (negative === "up" && positive === "down") {
        return stick.y;
      }
      if (negative === "down" && positive === "up") {
        return -stick.y;
      }
      return 0;
    },
    vector(left = "left", right = "right", down = "down", up = "up") {
      let x = (digital.has(right) ? 1 : 0) - (digital.has(left) ? 1 : 0);
      let y = (digital.has(up) ? 1 : 0) - (digital.has(down) ? 1 : 0);
      const defaults = left === "left" && right === "right" && down === "down" && up === "up";
      if (x === 0 && y === 0 && defaults) {
        x = stick.x;
        y = -stick.y;
      }
      const length = Math.hypot(x, y);
      return length > 1 ? { x: x / length, y: y / length } : { x, y };
    },
    look: () => ({ ...look }),
    /** Declares the controls a touch screen shows; each new version of the game declares its own. */
    touch(options) {
      layout = touchLayout(options);
      layer ??= createTouchLayer({ turning });
      layer?.build(layout, Object.hasOwn(actions, "pause"));
      layer?.show(mode === "touch");
      return layer?.element;
    },
    get mode() {
      return mode;
    },
    bind(changes) {
      const next = { ...actions, ...changes };
      codes = codeMap(next);
      actions = next;
      if (layout) {
        layer?.build(layout, Object.hasOwn(actions, "pause"));
      }
    },
    get bindings() {
      return actions;
    },
    /** Back to the default bindings; the runtime calls it before each new game version binds. */
    reset() {
      actions = { ...bindings };
      codes = codeMap(actions);
      layout = null;
      for (const id of [...fingers.keys()]) {
        releaseFinger(id);
      }
      layer?.build(null);
    },
    clear,
    dispose() {
      for (const [type, listener] of listeners) {
        target.removeEventListener(type, listener);
      }
      globalThis.document?.removeEventListener("visibilitychange", onVisibility);
      screen?.removeEventListener?.("change", onScreen);
      layer?.remove();
      layer = null;
    },
  };
}
