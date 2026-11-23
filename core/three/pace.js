// How fast and how sharp a game draws on the machine that plays it, and only there: nothing here
// is saved with the game, so a game made on a slow machine plays in full on a fast one.
//
// The frame rate follows the display: 120 Hz screens get 120 fps while the machine keeps up. When
// it does not (three seconds in a row under nine tenths of the display's rate) the game draws
// every other refresh, a steady half of the display's rate (60 on 120 Hz, 72 on 144 Hz), since a
// rate wandering below the display's looks worse than a steady one; a frame can only be shown on
// a refresh, so any other fixed rate (60 on 144 Hz) lands on every third and gives 48. Displays
// under 110 Hz are not halved. The display's rate is tried again after a minute. Only below 60
// does the picture give way: three seconds in
// a row under 45 fps lower the resolution a step (a tenth of the full pixel ratio, down to six
// tenths), then turn shadows off; eight seconds in a row at 57 fps or more raise it a step again,
// so a busy moment does not lower it for good. A hidden page, whose frames the browser throttles,
// and a single long stall (a model loading) say nothing about the machine and are not counted.

/** Quality steps from the full pixel ratio: the resolution down to six tenths, then no shadows. */
export function qualitySteps(fullRatio) {
  return [
    ...[1, 0.9, 0.8, 0.7, 0.6].map((scale) => ({ ratio: fullRatio * scale, shadows: true })),
    { ratio: fullRatio * 0.6, shadows: false },
  ];
}

const HELD_FOR_MS = 60_000;

/**
 * The display's refresh rate, from the median interval of a few frames while the loading screen
 * shows, when frames are light: a game's own frames cannot tell it, since a game that keeps up
 * with 90 fps on a 120 Hz screen draws at uneven intervals. 0 when it cannot be told (a hidden
 * page gets no frames).
 */
export function measureDisplayRate(frames = 40, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const intervals = [];
    let last = 0;
    const timeout = setTimeout(() => resolve(0), timeoutMs);
    const tick = (time) => {
      if (last) intervals.push(time - last);
      last = time;
      if (intervals.length < frames) {
        requestAnimationFrame(tick);
        return;
      }
      clearTimeout(timeout);
      const sorted = intervals.sort((a, b) => a - b);
      resolve(Math.round(1000 / sorted[Math.floor(sorted.length / 2)]));
    };
    requestAnimationFrame(tick);
  });
}

/**
 * The pacer of one page, for a display of `state.refresh` Hz (measureDisplayRate; 0 when unknown).
 * `state` carries over a hot update. `frame(time)` runs at every display
 * frame and says whether to draw it; `watch(elapsed)` runs after each drawn frame and returns the
 * new quality step when it changes, or null.
 */
export function createPacer(steps, state = {}) {
  const s = Object.assign(
    {
      refresh: 0,
      held: false,
      heldAt: 0,
      last: 0,
      frames: 0,
      time: 0,
      slowAtDisplay: 0,
      slow: 0,
      fast: 0,
      step: 0,
    },
    state,
  );
  s.step = Math.min(s.step, steps.length - 1);

  return {
    state: s,
    steps,
    /** Whether to draw the display frame at `time` (milliseconds). */
    frame(time) {
      if (s.held && time - s.heldAt > HELD_FOR_MS) {
        s.held = false;
      }
      // Every other refresh: skip a frame that comes sooner than one and a half refreshes.
      if (s.held && time - s.last < (1000 / s.refresh) * 1.5) {
        return false;
      }
      s.last = time;
      return true;
    },
    /** After a drawn frame of `elapsed` seconds; `hidden` when the page cannot be seen. */
    watch(elapsed, hidden = false, now = 0) {
      if (hidden || elapsed > 0.25) {
        s.frames = 0;
        s.time = 0;
        return null;
      }
      s.frames += 1;
      s.time += elapsed;
      if (s.time < 1) {
        return null;
      }
      const fps = s.frames / s.time;
      s.frames = 0;
      s.time = 0;
      if (s.refresh >= 110 && !s.held) {
        s.slowAtDisplay = fps < s.refresh * 0.9 ? s.slowAtDisplay + 1 : 0;
        if (s.slowAtDisplay >= 3) {
          s.held = true;
          s.heldAt = now;
          s.slowAtDisplay = 0;
        }
      }
      s.slow = fps < 45 ? s.slow + 1 : 0;
      s.fast = fps >= 57 ? s.fast + 1 : 0;
      if (s.slow >= 3 && s.step < steps.length - 1) {
        s.step += 1;
      } else if (s.fast >= 8 && s.step > 0) {
        s.step -= 1;
      } else {
        return null;
      }
      s.slow = 0;
      s.fast = 0;
      return s.step;
    },
  };
}
