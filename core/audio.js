// Sound without audio files: ZzFX builds each effect from a short list of numbers, played on three
// buses (music, sfx, ui) under one master gain. Browsers start audio muted until the player
// presses a key or clicks; the first such gesture unlocks it.
//
//   audio.sfx([,,925,.04,.3,.6,1,.3,,6.27,-184,.09,.17])   an effect (paste ZzFX designer arrays)
//   audio.sfx(params, { bus: "ui", volume: 0.5, pitch: 1.2 })
//   audio.setVolume("music", 0.4); audio.toggleMute()
//
// A game for several players has the multiplayer kit's sound controls in a corner of the page
// (core/mp/sound.js): from then on that is the one mute, and `muted`, `setMuted` and `toggleMute`
// here read and set it (`follow`). The game's own mute is lifted, so the two never disagree.
//
// Silence is better than a poor loop: a game without music keeps the music bus empty.
//
// A long sound from a file (music, an ambience) is a track: downloaded once and kept as
// downloaded, decoded when it plays and released once it has faded out. Decoded, three minutes of
// stereo hold about 70 MB, so only what is playing stays decoded.
//
//   const theme = audio.track("audio/theme.mp3");   theme.play();  …  theme.stop();
// core/zzfx.js is ZzFX 1.4.0's ZzFX.js, byte for byte, with its MIT notice: one file, kept as
// part of the game rather than installed.
import { ZZFX } from "./zzfx.js";
import { assetUrl, storageKey } from "./paths.js";

// Games served from one site share its storage, so the key is this game's own.
const MUTED_KEY = storageKey("muted");
const readMuted = () => {
  try {
    return globalThis.localStorage?.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeMuted = (muted) => {
  try {
    globalThis.localStorage?.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    // Storage can be unavailable; the setting then lasts this session.
  }
};

export function createAudio() {
  const context = new AudioContext();
  const master = context.createGain();
  master.connect(context.destination);
  const buses = Object.fromEntries(
    ["music", "sfx", "ui"].map((name) => {
      const gain = context.createGain();
      gain.connect(master);
      return [name, gain];
    }),
  );
  let muted = readMuted();
  master.gain.value = muted ? 0 : 1;
  /** The platform's sound control once the game follows one: { sound, set(change) }. */
  let platform = null;
  const cache = new Map();

  const unlock = () => {
    if (context.state !== "running") {
      void context.resume();
    }
  };
  for (const event of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(event, unlock, { capture: true });
  }

  // An effect is built once, without ZzFX's pitch randomness (its second number, 0.05 when left
  // out); each play varies its pitch by that amount instead, so a repeated effect never sounds
  // copied, as ZzFX does itself.
  const buffer = (params) => {
    const key = JSON.stringify(params);
    let cached = cache.get(key);
    if (!cached) {
      const steady = [...params];
      steady[1] = 0;
      const samples = ZZFX.buildSamples(...steady);
      const data = context.createBuffer(1, samples.length, ZZFX.sampleRate);
      data.getChannelData(0).set(samples);
      cached = { data, randomness: params[1] ?? 0.05 };
      cache.set(key, cached);
    }
    return cached;
  };

  return {
    context,
    /** Plays one effect; returns its source so a looping sound can be stopped. */
    sfx(params, { bus = "sfx", volume = 1, pitch = 1, loop = false } = {}) {
      if (context.state !== "running") {
        return undefined;
      }
      const source = context.createBufferSource();
      const { data, randomness } = buffer(params);
      source.buffer = data;
      source.playbackRate.value = pitch * (1 + randomness * (Math.random() * 2 - 1));
      source.loop = loop;
      const gain = context.createGain();
      gain.gain.value = volume * ZZFX.volume;
      source.connect(gain).connect(buses[bus] ?? buses.sfx);
      source.start();
      return source;
    },
    /**
     * A long sound from a file under public/, looping unless told otherwise. play() fades it in
     * (the first play waits for the download and the decoding); stop() fades it out and lets the
     * decoded sound go. load() downloads it ahead of its first play. It plays through a buffer
     * source, whose loop has no gap; an <audio> element's has one.
     */
    track(path, { bus = "music", volume = 1, loop = true, fade = 0.6 } = {}) {
      let file;
      let playing;
      let request = 0;
      const download = () =>
        (file ??= fetch(assetUrl(path)).then((response) => {
          if (!response.ok) {
            throw new Error(`${path} answered ${response.status}`);
          }
          return response.arrayBuffer();
        }));
      return {
        load: () => download().then(() => undefined),
        get playing() {
          return Boolean(playing);
        },
        async play() {
          if (playing) {
            return;
          }
          const mine = ++request;
          // Decoding empties the bytes it is given, so it gets a copy and the download stays.
          const sound = await context.decodeAudioData((await download()).slice(0));
          if (mine !== request || playing) {
            return;
          }
          const source = context.createBufferSource();
          source.buffer = sound;
          source.loop = loop;
          const gain = context.createGain();
          gain.gain.setValueAtTime(0, context.currentTime);
          gain.gain.linearRampToValueAtTime(volume, context.currentTime + fade);
          source.connect(gain).connect(buses[bus] ?? buses.music);
          source.start();
          playing = { source, gain };
          source.onended = () => {
            if (playing?.source === source) {
              playing = undefined;
            }
          };
        },
        stop() {
          request += 1;
          const ending = playing;
          playing = undefined;
          if (!ending) {
            return;
          }
          const end = context.currentTime + fade;
          ending.gain.gain.cancelScheduledValues(context.currentTime);
          ending.gain.gain.setValueAtTime(ending.gain.gain.value, context.currentTime);
          ending.gain.gain.linearRampToValueAtTime(0, end);
          ending.source.onended = () => {
            ending.source.disconnect();
            ending.gain.disconnect();
          };
          ending.source.stop(end);
        },
      };
    },
    /** A bus to connect your own nodes to, for example a music source. */
    bus: (name) => buses[name],
    setVolume(bus, value) {
      buses[bus].gain.value = value;
    },
    get muted() {
      return platform ? platform.sound.muted : muted;
    },
    setMuted(next) {
      if (platform) {
        platform.set({ muted: next });
        return;
      }
      muted = next;
      master.gain.value = muted ? 0 : 1;
      writeMuted(muted);
    },
    toggleMute() {
      this.setMuted(!this.muted);
      return this.muted;
    },
    /**
     * Hands the mute to the platform's sound control (`session.sound` of a game for several
     * players): this master gain opens, what was kept of the game's own mute is no longer read,
     * and the platform's control, which comes after it, is what silences the page.
     *
     * This gain reached the speakers before the kit was installed, and the kit's control takes
     * only connections made after it (core/mp/sound.js): connected again here, it goes through
     * that control's gain, so the page's volume and mute reach this game's sound.
     */
    follow(control) {
      if (!control?.sound || typeof control.set !== "function") {
        return;
      }
      platform = control;
      muted = false;
      master.gain.value = 1;
      master.disconnect();
      master.connect(context.destination);
    },
  };
}
