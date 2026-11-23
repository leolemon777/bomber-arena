// The runtime of a pure 2D game, on Phaser 4. index.html loads it in place of the three.js runtime
// (<script type="module" src="/core/phaser/runtime.js">). One Phaser.Game lives across hot
// updates; each version of src/game.js adds its own scene and removes it in dispose():
//
//   export const config = { pixelArt: true, backgroundColor: "#1d2433",
//                           physics: { default: "arcade", arcade: { gravity: { y: 900 } } } };
//   export function createGame({ game, Phaser, state, flow, input, audio, tuning, ui })
//     → { save(), dispose(), picture?(on) }
//
// The scene starts with `state` (what the previous version's save() returned). `config` is read
// when the game boots; changing it reloads the page. Images the scene loads, and the animations
// made from them, are dropped between versions, so a rewritten sprite sheet shows on the next swap
// and preload() and create() run as on a fresh start. Phaser's own
// documentation for agents is in node_modules/phaser/skills/ (v3-to-v4-migration lists the APIs
// that changed since Phaser 3).
//
// A game for several players also has src/logic.js, its rules. createGame then
// gets `session` as well: the match's state for this player and the way to send actions and
// commands. The match runs in the rules, so the runtime does not pause such a game.
// First, so that Phaser's own images load under a policy that refuses data: addresses.
import "./data-images.js";
import Phaser from "phaser";
import * as gameModule from "../../src/game.js";
import { createAudio } from "../audio.js";
import { createFlow } from "../flow.js";
import { createInput } from "../input.js";
import { createPicture, hideElement, hidePhaserHud } from "../picture.js";
import { finishLoading, loadReport, markSettled, showProgress } from "../loading.js";
import { createReadout } from "../readout.js";
import { loadTuning } from "../tuning.js";

const kept = import.meta.hot?.data ?? {};
const configKey = JSON.stringify(gameModule.config ?? {});

const game =
  kept.game ??
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: document.body,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    ...(gameModule.config ?? {}),
  });
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
const readout = kept.readout ?? createReadout();
const bootTextures = kept.bootTextures ?? new Set(game.textures.getTextureKeys());
const bootAnimations = kept.bootAnimations ?? new Set(game.anims.anims.keys());

function start(module, state) {
  shared.flow.clearListeners();
  shared.tuning.clearListeners();
  shared.input.reset();
  shared.ui?.replaceChildren();
  return module.createGame({ game, Phaser, state: state ?? {}, ...shared }) ?? {};
}

function stop(current) {
  current.dispose?.();
  // Animations are global in Phaser and point at textures: both go, so the next version builds
  // its own from freshly loaded images.
  for (const key of [...game.anims.anims.keys()]) {
    if (!bootAnimations.has(key)) {
      game.anims.remove(key);
    }
  }
  for (const key of game.textures.getTextureKeys()) {
    if (!bootTextures.has(key)) {
      game.textures.remove(key);
    }
  }
}

// The rules of a game for several players, when the folder has them, and the multiplayer kit that
// runs them (core/mp/, which the web games Skill installs: a game for one player has neither,
// gets no session and loads none of it). Both are looked for by pattern, so this file is the same
// with the kit and without it. The rules run in this page when playing alone and in a room when
// the address names one (core/mp/boot.js). Alone, the match starts with the session, so it is
// started last, right before the view.
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

// The loading screen stays while the first scene loads its images, showing the loader's progress,
// and goes once a scene runs (or after a second with nothing loading, for a game without scenes).
let loadingSteps = kept.game ? -1 : 0;
const watchLoading = () => {
  loadingSteps += 1;
  const scenes = game.scene.getScenes(false);
  const loader = scenes.find((scene) => scene.load?.isLoading())?.load;
  if (loader) {
    showProgress(loader.progress);
  }
  const running = scenes.some((scene) => scene.sys.settings.status === Phaser.Scenes.RUNNING);
  if (running || (!loader && loadingSteps > 60)) {
    loadingSteps = -1;
    finishLoading();
    // A 2D game's scenes load their own images; nothing follows the first frame here.
    markSettled();
  }
};

const onStep = () => {
  if (loadingSteps >= 0) {
    watchLoading();
  }
  shared.input.update();
  // A match runs in the rules, which paused scenes would not stop: a game with a session pauses
  // with a command its rules decide on.
  if (!shared.session && shared.input.pressed("pause")) {
    shared.flow.togglePause();
  }
  const now = performance.now();
  readout.frame(game.loop.delta, now, document.hidden);
  readout.remember(() => current.save?.(), shared.flow.state, now);
  const paused = !shared.session && shared.flow.state === "paused";
  for (const scene of game.scene.getScenes(false)) {
    if (paused && scene.sys.isActive()) {
      game.scene.pause(scene);
    } else if (!paused && scene.sys.isPaused()) {
      game.scene.resume(scene);
    }
  }
};
game.events.on(Phaser.Core.Events.PRE_STEP, onStep);

/** How the last ten seconds ran, with what each running scene holds, for a game that stutters. */
function stats() {
  const scenes = game.scene.getScenes(true).map((scene) => ({
    key: scene.sys.settings.key,
    objects: scene.children?.length ?? 0,
    bodies: scene.physics?.world?.bodies?.size ?? 0,
  }));
  return {
    ...readout.frames(performance.now()),
    scenes,
    textures: game.textures.getTextureKeys().length,
  };
}

// For checks from the browser: window.__game.save() returns what the game would keep, stats() how
// smoothly it runs and history() what save() returned each second of the last minute. The app's
// game mode calls restart() for its Restart round, and hold() and release() around the person
// typing to the Agent, when the keyboard is not the game's, and reads and sets the values of its
// tuning panel through tuning (core/tuning.js). session is the multiplayer session (phase, lobby,
// state) of a game that has rules in src/logic.js. picture(true) hides the HUD and text for a
// picture of the game and picture(false) brings them back: the #ui layer, every text object and
// every object marked setData("hud", true) or named "hud" (core/picture.js).
window.__game = {
  save: () => current.save?.(),
  flow: () => shared.flow.state,
  stats,
  history: () => readout.history(performance.now()),
  load: loadReport,
  restart: () => shared.flow.restart(),
  hold: () => shared.flow.hold(),
  release: () => shared.flow.release(),
  tuning: shared.tuning.panel,
  session: shared.session,
  picture: createPicture({
    layers: () => {
      const restoreUi = hideElement(shared.ui);
      const restoreTouch = hideElement(document.getElementById("touch"));
      const objects = hidePhaserHud(game);
      return {
        hidden: () => [
          ...(restoreUi ? ["#ui"] : []),
          ...(restoreTouch ? ["#touch"] : []),
          ...(objects.count ? [`${objects.count} text and HUD objects`] : []),
        ],
        again: objects.again,
        restore: () => {
          restoreUi?.();
          restoreTouch?.();
          objects.restore();
        },
      };
    },
    game: () => current,
  }),
};

import.meta.hot?.accept();
import.meta.hot?.accept("../../src/game.js", (next) => {
  if (!next) {
    return;
  }
  if (JSON.stringify(next.config ?? {}) !== configKey) {
    // Phaser reads its config once, when the game boots.
    window.location.reload();
    return;
  }
  const state = current.save?.();
  stop(current);
  current = start(next, state);
});

import.meta.hot?.dispose((data) => {
  data.game = game;
  data.shared = shared;
  data.logicModule = logicModule;
  data.bootTextures = bootTextures;
  data.bootAnimations = bootAnimations;
  data.readout = readout;
  data.state = current.save?.();
  game.events.off(Phaser.Core.Events.PRE_STEP, onStep);
  stop(current);
});
