// What a running game shows the Agent through window.__game, without changing it: how evenly its
// frames came over the last ten seconds, and what the game's save() returned each second of the
// last minute, so the moment the person describes can be read after they have played on. Both
// readings are copies.

const FRAME_WINDOW_MS = 10_000;
const STATE_EVERY_MS = 1000;
const STATES_KEPT = 60;
const MAX_STATE_CHARS = 32 * 1024;
/** A frame that took this long missed at least two refreshes at 60 Hz: the person sees a hitch. */
export const LONG_FRAME_MS = 50;
/** A gap longer than this is a page put away and brought back, not a frame the person saw. */
export const AWAY_MS = 1000;

const round = (value) => Math.round(value * 10) / 10;

/** The value at a share of the sorted durations, e.g. 0.95 for the 95th percentile. */
function percentile(sorted, share) {
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

/** The runtime keeps one across hot updates. Every `now` is performance.now(). */
export function createReadout() {
  const frames = [];
  const states = [];

  function forget(now) {
    while (frames.length && frames[0].at < now - FRAME_WINDOW_MS) {
      frames.shift();
    }
  }

  return {
    /** Records one frame's duration. A hidden page's frames say nothing about the game. */
    frame(ms, now, hidden = false) {
      if (hidden || !Number.isFinite(ms) || ms <= 0 || ms > AWAY_MS) {
        return;
      }
      frames.push({ at: now, ms });
      forget(now);
    },

    /** Takes what `save()` returns once a second, as text, so later changes to it do not show. */
    remember(save, flow, now) {
      const last = states.at(-1);
      if (last && now - last.at < STATE_EVERY_MS) {
        return;
      }
      let text;
      try {
        text = JSON.stringify(save() ?? {});
        if (text.length > MAX_STATE_CHARS) {
          text = JSON.stringify({ omitted: `save() returned ${text.length} characters` });
        }
      } catch (error) {
        text = JSON.stringify({ error: `save() failed: ${error?.message ?? error}` });
      }
      states.push({ at: now, flow, text });
      if (states.length > STATES_KEPT) {
        states.shift();
      }
    },

    /** Frame rate and frame times in milliseconds over the last ten seconds. */
    frames(now) {
      forget(now);
      if (frames.length < 2) {
        return { seconds: 0, frames: frames.length };
      }
      const sorted = frames.map((frame) => frame.ms).sort((a, b) => a - b);
      const total = sorted.reduce((sum, ms) => sum + ms, 0);
      return {
        seconds: round(total / 1000),
        frames: sorted.length,
        fps: round((sorted.length * 1000) / total),
        medianMs: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        worstMs: round(sorted.at(-1)),
        longFrames: sorted.filter((ms) => ms >= LONG_FRAME_MS).length,
      };
    },

    /** The last minute of saved states, oldest first, each with how many seconds ago it was taken. */
    history(now) {
      return states.map(({ at, flow, text }) => ({
        secondsAgo: round((now - at) / 1000),
        flow,
        state: JSON.parse(text),
      }));
    },
  };
}
