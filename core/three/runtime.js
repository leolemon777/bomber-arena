// The runtime of a three.js game (3D and 2.5D): the renderer, camera and frame loop, and the
// game's flow, input, audio and tuning. They stay the same across hot updates, so an edit to
// src/game.js, or to any module it imports, swaps the game in place without reloading the page or
// moving the camera. index.html loads this file; the game itself lives in src/game.js:
//
//   export function createGame({ scene, camera, renderer, lighting, state, flow, input, audio, tuning, things, ui })
//     → { update(delta), save(), dispose(), render?(), picture?(on) }
//
// scene is new for each version; state is what the previous version's save() returned ({} at
// first); ui is a layer over the canvas that lets clicks through to the game except on elements
// with class "hit". The runtime pauses on the "pause" action and skips update() while paused.
// lighting (lighting.js) is the scene's light: a sky, a sun and the fog already in place, a time
// of day, a grade and a style to choose. Each frame goes through the post chain (post.js);
// render(), when the game has one, replaces it; picture(on), when it has one, hides and shows
// again what the game draws of its HUD in the scene, for a picture of the game without it
// (core/picture.js). The renderer is WebGPURenderer, on WebGL2 where
// there is no WebGPU; shaders are written in TSL. On the first load the manifest's models on disk,
// all but those marked "preload": false, load behind the loading screen before createGame runs,
// and the first scene's shaders compile there too.
//
// A game for several players also has src/logic.js, its rules. createGame then
// gets `session` as well: the match's state for this player and the way to send actions and
// commands. The match runs in the rules, so the runtime does not pause such a game.
import * as THREE from "three";
import * as gameModule from "../../src/game.js";
import { clearPlacements, disposeObject, preloadModels, settleModels } from "../assets.js";
import { createAudio } from "../audio.js";
import { createFlow } from "../flow.js";
import { createInput } from "../input.js";
import { createPicture, hideElement } from "../picture.js";
import { finishLoading, loadReport, markSettled, showProgress, watchSettling } from "../loading.js";
import { createReadout } from "../readout.js";
import { loadThings } from "../things.js";
import { loadTuning } from "../tuning.js";
import { createLighting } from "./lighting.js";
import { createPacer, measureDisplayRate, qualitySteps } from "./pace.js";
import { createPipeline } from "./post.js";

const kept = import.meta.hot?.data ?? {};

// Anti-aliasing is TRAA's, in the post chain; exposure is applied there too, before bloom.
const renderer = kept.renderer ?? new THREE.WebGPURenderer({ antialias: false });
if (!kept.renderer) {
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  // PCF shadows are soft since three r182, which removed PCFSoftShadowMap.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.prepend(renderer.domElement);
}
const camera = kept.camera ?? new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
const timer = kept.timer ?? new THREE.Timer();
const readout = kept.readout ?? createReadout();
// The counts cover every render call of a frame (a game's own render() may make several); the loop
// resets them once per frame.
renderer.info.autoReset = false;
const shared = kept.shared ?? {
  flow: createFlow(),
  // While a phone is held the other way from the game's declared shape, the game holds.
  input: createInput({
    turning: (asking) => (asking ? shared.flow.hold("turn") : shared.flow.release("turn")),
  }),
  audio: createAudio(),
  tuning: await loadTuning(),
  ui: document.getElementById("ui"),
};
// The things of public/things.json and the kinds the game makes them of (core/things.js).
shared.things ??= await loadThings();
// The editor's side of the page, only while the game is built: a build leaves this import out.
const inspect =
  kept.inspect ??
  (import.meta.hot
    ? (await import("../inspect.js")).createInspect({ renderer, camera, ...shared })
    : undefined);

function resize() {
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener("resize", resize);

// The frame rate and resolution adapt to the machine that plays (pace.js).
const pacer = createPacer(qualitySteps(Math.min(window.devicePixelRatio, 2)), kept.pace);
function applyQuality(step) {
  const { ratio, shadows } = pacer.steps[step];
  if (renderer.shadowMap.enabled !== shadows) {
    renderer.shadowMap.enabled = shadows;
    // Materials build their shaders with or without shadows; switching needs them rebuilt, or the
    // last shadow map stays frozen on screen.
    current.scene.traverse((object) => {
      for (const material of [object.material].flat()) {
        if (material) {
          material.needsUpdate = true;
        }
      }
    });
  }
  renderer.setPixelRatio(ratio);
  resize();
}

/** A game starts in a scene of its own, from the state the previous version saved, if any. */
function start(module, state) {
  shared.flow.clearListeners();
  shared.tuning.clearListeners();
  shared.input.reset();
  shared.ui?.replaceChildren();
  clearPlacements();
  const scene = new THREE.Scene();
  shared.things.reset(scene);
  const lighting = createLighting({ scene, renderer, camera });
  const pipeline = createPipeline(renderer, scene, camera, lighting.look);
  const game = module.createGame({
    scene,
    camera,
    renderer,
    lighting,
    state: state ?? {},
    ...shared,
  });
  // The kinds are declared: the file's things take their places, and the editor finds the scene.
  shared.things.begin();
  inspect?.attach(scene);
  return { scene, game, lighting, pipeline };
}

/**
 * Frees what a game's scene holds on the GPU (lights' shadow maps and the background included), so
 * swapping games does not grow memory. Loaded model files stay for the next version.
 */
function stop({ scene, game, lighting, pipeline }) {
  game.dispose?.();
  shared.things.reset();
  pipeline.dispose();
  lighting.dispose();
  disposeObject(scene);
  for (const texture of [scene.background, scene.environment]) {
    if (texture?.isTexture) {
      texture.dispose();
    }
  }
}

if (!kept.renderer) {
  await preloadModels(showProgress);
  pacer.state.refresh = await measureDisplayRate();
}
// The rules of a game for several players, when the folder has them, and the multiplayer kit that
// runs them (core/mp/, which the web games Skill installs: a game for one player has neither,
// gets no session and loads none of it). Both are looked for by pattern, so this file is the same
// with the kit and without it. The rules run in this page when playing alone and in a room when
// the address names one (core/mp/boot.js), and the view never needs to know which. Alone, the
// match starts with the session, so it is started last: after the models are in, right before
// the view that draws it.
const [logicModule] = Object.values(import.meta.glob("../../src/logic.js", { eager: true }));
const [loadKit] = Object.values(import.meta.glob("../mp/boot.js"));
if (kept.logicModule && kept.logicModule !== logicModule) {
  // New rules need a new match: the page starts over.
  window.location.reload();
}
if (logicModule && !loadKit) {
  // Rules with nothing to run them: said here, instead of a game that plays as if it had none.
  throw new Error(
    "src/logic.js needs the multiplayer kit in core/mp/: install it with the web games Skill's scripts/add-multiplayer.mjs.",
  );
}
if (logicModule && !shared.session) {
  // The kit draws the room's chat and the page's sound along the bottom edge: touch controls
  // stand above them (core/touch.js).
  document.documentElement.style.setProperty("--touch-bottom", "52px");
  const { startSession } = await loadKit();
  shared.session = await startSession(logicModule);
}
// The kit's sound controls are the one mute of a game that has them: the game's own follows.
shared.audio.follow?.(shared.session?.sound);
let current = start(gameModule, kept.state);
let drawn = false;
if (!kept.renderer) {
  // The first scene's shaders compile behind the loading screen, not in the first seconds of play.
  current.lighting.prepare();
  await renderer.compileAsync(current.scene, camera).catch(console.error);
  if (!current.game.render) await current.pipeline.prepare().catch(console.error);
}

renderer.setAnimationLoop((time) => {
  if (!pacer.frame(time)) {
    return;
  }
  timer.update(time);
  const elapsed = timer.getDelta();
  // A tab put away for a while comes back with one ordinary frame, not a jump.
  const delta = Math.min(elapsed, 0.1);
  shared.input.update();
  // A match runs in the rules, which a paused view would not stop: a game with a session pauses
  // with a command its rules decide on.
  if (!shared.session && shared.input.pressed("pause")) {
    shared.flow.togglePause();
  }
  // The editor freezes the world whatever state the game is in, steps it and slows it down.
  const passed = inspect ? inspect.advance(delta) : delta;
  if (passed !== null && (shared.session || shared.flow.state !== "paused")) {
    shared.things.update(passed);
    current.game.update?.(passed);
  }
  inspect?.frame();
  watchSettling(elapsed * 1000, document.hidden);
  current.lighting.update();
  renderer.info.reset();
  if (current.game.render) {
    current.game.render(delta);
  } else {
    current.pipeline.render();
  }
  // An editor kept from before a hot update of this file may be an older one.
  inspect?.draw?.();
  const baking = current.lighting.stats().bake.pending === true;
  if (!drawn && !baking) {
    drawn = true;
    finishLoading();
    // A packaged game's full textures and later models follow the first frame.
    void settleModels().catch(console.error).finally(markSettled);
  }
  const step = pacer.watch(elapsed, document.hidden, time);
  if (step !== null) {
    applyQuality(step);
  }
  const now = performance.now();
  readout.frame(elapsed * 1000, now, document.hidden);
  readout.remember(() => current.game.save?.(), shared.flow.state, now);
});

/** How the last ten seconds ran, with what was drawn in the last frame, for a game that stutters. */
function stats() {
  const { step, refresh, held } = pacer.state;
  const { ratio, shadows } = pacer.steps[step];
  const { render, memory } = renderer.info;
  return {
    ...readout.frames(performance.now()),
    quality: { step: step + 1, of: pacer.steps.length, pixelRatio: ratio, shadows },
    frameRate: { display: refresh || null, heldAtHalf: held },
    backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2",
    lighting: current.lighting.stats(),
    drawCalls: render.drawCalls,
    triangles: render.triangles,
    geometries: memory.geometries,
    textures: memory.textures,
    shaders: memory.programs,
  };
}

// For checks from the browser: window.__game.save() returns what the game would keep, stats() how
// smoothly it runs and history() what save() returned each second of the last minute. The app's
// game mode calls restart() for its Restart round, and hold() and release() around the person
// typing to the Agent, when the keyboard is not the game's, and reads and sets the values of its
// tuning panel through tuning (core/tuning.js). session is the multiplayer session (phase, lobby,
// state) of a game that has rules in src/logic.js. picture(true) hides the HUD and text for a
// picture of the game and picture(false) brings them back. While the game is built, the app's
// editor freezes the world and points at what is in it through inspect (core/inspect.js) and
// changes the things of public/things.json through things (core/things.js).
window.__game = {
  save: () => current.game.save?.(),
  flow: () => shared.flow.state,
  stats,
  history: () => readout.history(performance.now()),
  load: loadReport,
  restart: () => shared.flow.restart(),
  hold: () => shared.flow.hold(),
  release: () => shared.flow.release(),
  tuning: shared.tuning.panel,
  things: shared.things.panel,
  inspect: inspect?.hooks,
  session: shared.session,
  picture: createPicture({
    layers: () => {
      const restore = hideElement(shared.ui);
      const restoreTouch = hideElement(document.getElementById("touch"));
      return {
        hidden: () => [...(restore ? ["#ui"] : []), ...(restoreTouch ? ["#touch"] : [])],
        restore: () => {
          restore?.();
          restoreTouch?.();
        },
      };
    },
    game: () => current.game,
  }),
};

// An edit to this file runs it again with the same renderer, camera, shared parts and game state.
import.meta.hot?.accept();
import.meta.hot?.accept("../../src/game.js", (next) => {
  if (next) {
    const state = current.game.save?.();
    stop(current);
    current = start(next, state);
  }
});

import.meta.hot?.dispose((data) => {
  data.renderer = renderer;
  data.camera = camera;
  data.timer = timer;
  data.shared = shared;
  data.inspect = inspect;
  data.logicModule = logicModule;
  data.pace = pacer.state;
  data.readout = readout;
  data.state = current.game.save?.();
  renderer.setAnimationLoop(null);
  window.removeEventListener("resize", resize);
  stop(current);
});
