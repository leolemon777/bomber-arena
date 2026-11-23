// The loading screen: #loading in index.html covers the page from its first paint until the
// runtime has drawn the game's first frame with the models the start waits for in place. Each game
// designs what is inside it. Its content shows from 0.3 s after the page started (the class
// "shown"), so a quick load shows only its background; --progress on #loading runs from 0 to 1. A
// page without #loading (a game made from an older template) simply has no loading screen.
//
// The module also keeps what the page had asked for when the first frame was drawn, for measuring
// a cold load: window.__game.load() answers seconds, requests and megabytes then and now, and how
// the frames went while a packaged game's full textures and later models came in.

import { AWAY_MS, LONG_FRAME_MS } from "./readout.js";

const screen = globalThis.document?.getElementById("loading");
if (screen) {
  setTimeout(() => screen.classList.add("shown"), Math.max(0, 300 - performance.now()));
}

/** Shows how much has loaded, from 0 to 1. */
export function showProgress(fraction) {
  screen?.style.setProperty("--progress", String(Math.min(Math.max(fraction, 0), 1)));
}

/** Seconds since the page started, and what it has asked the server for so far. */
function soFar() {
  const entries = [
    ...(globalThis.performance?.getEntriesByType?.("navigation") ?? []),
    ...(globalThis.performance?.getEntriesByType?.("resource") ?? []),
  ];
  const bytes = entries.reduce(
    (total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0),
    0,
  );
  return {
    seconds: Math.round(performance.now() / 10) / 100,
    requests: entries.length,
    megabytes: Math.round((bytes / 1048576) * 100) / 100,
  };
}

let firstFrame;
let settled = false;
/** The frames between the first frame and the last load that follows it. */
const settling = { frames: 0, worstMs: 0, longFrames: 0 };
let counting = false;

/** Removes the loading screen; the runtime calls it after the first frame is drawn. */
export function finishLoading() {
  firstFrame ??= soFar();
  screen?.remove();
}

/** The runtime calls it once everything a packaged game loads after its first frame is in. */
export function markSettled() {
  settled = true;
}

/**
 * The runtime gives every frame's milliseconds, before it draws. The frames of a packaged game are
 * counted while its full textures and later models come in: a long one there is a hitch the
 * person sees as the game opens. The frame after the first carries the first draw and is left out.
 */
export function watchSettling(ms, hidden = false) {
  if (!counting) {
    counting = firstFrame !== undefined;
    return;
  }
  if (settled || hidden || !Number.isFinite(ms) || ms <= 0 || ms > AWAY_MS) {
    return;
  }
  settling.frames += 1;
  settling.worstMs = Math.max(settling.worstMs, Math.round(ms * 10) / 10);
  settling.longFrames += ms >= LONG_FRAME_MS ? 1 : 0;
}

/**
 * How the page loaded: what it had asked for at the first frame, what it has asked for by now,
 * whether the loads that follow the first frame are done, and how the frames went meanwhile.
 */
export function loadReport() {
  return { firstFrame, now: soFar(), settled, settling: { ...settling } };
}
