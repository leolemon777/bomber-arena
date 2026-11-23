// The game's flow: ready, playing, paused, over. It holds no screens; the game draws its own start,
// pause and result views from these states and events.
//
//   flow.start()          ready or over → playing
//   flow.pause()          playing → paused (only the player's key, never a lost focus)
//   flow.resume()         paused → playing
//   flow.end(result)      playing or paused → over, with whatever the game reports (score, win)
//   flow.restart()        any → playing, after a "restart" event the game resets its world on
//   flow.hold(by)         something took the game from the player: "app" (the default) while the
//                         person types to the Agent, "turn" while a phone is held the wrong way up;
//                         pause if playing
//   flow.release(by)      it gave the game back: resume once nothing holds it, only if holding was
//                         what paused
//   flow.on(event, fn)    "change" ({ from, to }), a state's name, or "restart"; returns an off()

const MOVES = {
  start: { from: ["ready", "over"], to: "playing" },
  pause: { from: ["playing"], to: "paused" },
  resume: { from: ["paused"], to: "playing" },
  end: { from: ["playing", "paused"], to: "over" },
};

export function createFlow(initial = "ready") {
  let state = initial;
  let result;
  // What holds the game now, and whether holding paused it, so release() resumes nothing the
  // player paused themselves and one holder letting go does not resume what another still holds.
  const holders = new Set();
  let held = false;
  const listeners = new Map();

  const emit = (event, detail) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(detail);
    }
  };
  const go = (to, detail) => {
    const from = state;
    state = to;
    emit("change", { from, to, detail });
    emit(to, detail);
  };
  const move = (name, detail) => {
    if (!MOVES[name].from.includes(state)) {
      return false;
    }
    go(MOVES[name].to, detail);
    return true;
  };

  return {
    get state() {
      return state;
    },
    /** What the last end() reported, until the next start or restart. */
    get result() {
      return result;
    },
    start() {
      result = undefined;
      return move("start");
    },
    pause() {
      return move("pause");
    },
    resume() {
      return move("resume");
    },
    togglePause() {
      return state === "paused" ? move("resume") : move("pause");
    },
    end(outcome) {
      if (!MOVES.end.from.includes(state)) {
        return false;
      }
      result = outcome;
      go("over", outcome);
      return true;
    },
    restart() {
      result = undefined;
      held = false;
      holders.clear();
      emit("restart");
      go("playing");
      return true;
    },
    hold(by = "app") {
      holders.add(by);
      held ||= move("pause");
      return held;
    },
    release(by = "app") {
      holders.delete(by);
      if (holders.size > 0) {
        return false;
      }
      const mine = held;
      held = false;
      return mine && move("resume");
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    /** Drops every listener; the runtime calls it between game versions. */
    clearListeners() {
      listeners.clear();
    },
  };
}
