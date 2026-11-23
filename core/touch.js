// The controls a touch screen shows over the game (input.touch() in core/input.js declares them,
// and input.js reads the fingers): an area for the left thumb where a stick appears as it lands, an
// area to drag the view, the game's buttons under the right thumb and a pause button. Each part is
// an element of #touch, which lies under the game's #ui, so the HUD's .hit elements stay above it.
// The look here is neutral; a game restyles it in its own HUD's look through these:
//
//   #touch                       --touch-fill, --touch-held, --touch-line, --touch-text,
//                                --touch-font, and --touch-bottom, room kept free under the controls
//   .touch-stick, .touch-knob    the stick's ring and its thumb
//   .touch-button[data-action]   a button, its label as text
//   .touch-pause                 the pause button
//   .touch-turn                  the request to turn the phone
//
// A game that declares its screen shape (<meta name="game-aspect">) is played that way up: while
// a phone is held the other way, .touch-turn covers the game and asks to turn it, and `turning`
// hears it, so the runtime holds the game meanwhile.

const STYLE = `
#touch{--touch-fill:rgba(16,18,22,.28);--touch-held:rgba(255,255,255,.36);--touch-line:rgba(255,255,255,.62);--touch-text:#fff;--touch-font:600 15px system-ui,sans-serif;position:fixed;inset:0;pointer-events:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
#touch[hidden],#touch [hidden],.touch-turn[hidden]{display:none}
#touch .touch-area{position:absolute;top:0;bottom:0;pointer-events:auto;touch-action:none}
#touch .touch-stick{position:absolute;left:calc(88px + env(safe-area-inset-left));top:calc(100% - 88px - var(--touch-bottom, 0px) - env(safe-area-inset-bottom));width:128px;height:128px;margin:-64px 0 0 -64px;border-radius:50%;background:var(--touch-fill);box-shadow:inset 0 0 0 1px var(--touch-line);opacity:.45}
#touch .touch-stick[data-active]{opacity:1}
#touch .touch-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:var(--touch-held);box-shadow:inset 0 0 0 1px var(--touch-line)}
#touch .touch-buttons{position:absolute;right:calc(20px + env(safe-area-inset-right));bottom:calc(20px + var(--touch-bottom, 0px) + env(safe-area-inset-bottom));width:176px;height:176px}
#touch button{position:absolute;display:grid;place-items:center;padding:0 6px;border:0;border-radius:50%;background:var(--touch-fill);box-shadow:inset 0 0 0 1px var(--touch-line);color:var(--touch-text);font:var(--touch-font);line-height:1.1;text-shadow:0 1px 2px rgba(0,0,0,.35);text-align:center;overflow:hidden;pointer-events:auto;touch-action:none}
#touch button[data-held]{background:var(--touch-held)}
#touch .touch-button:nth-child(1){right:0;bottom:0;width:80px;height:80px}
#touch .touch-button:nth-child(2){right:96px;bottom:6px;width:62px;height:62px}
#touch .touch-button:nth-child(3){right:9px;bottom:96px;width:62px;height:62px}
#touch .touch-button:nth-child(4){right:86px;bottom:86px;width:54px;height:54px}
#touch .touch-pause{top:calc(14px + env(safe-area-inset-top));right:calc(14px + env(safe-area-inset-right));width:44px;height:44px}
#touch .touch-pause::before,#touch .touch-pause::after{content:"";position:absolute;top:15px;width:4px;height:14px;border-radius:1px;background:var(--touch-text)}
#touch .touch-pause::before{left:15px}
#touch .touch-pause::after{right:15px}
.touch-turn{position:fixed;inset:0;z-index:3;display:grid;place-items:center;background:rgba(8,10,14,.9);touch-action:none}
.touch-turn svg{width:96px;height:96px;color:#fff}
`;

const TURN_ICON = `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="32" y="14" width="32" height="56" rx="6"/><path d="M44 62h8"/><path d="M74 40a28 28 0 0 1-14 38"/><path d="M58 70l2 9 9-3"/></svg>`;

/** The declared screen shape: true for wide, false for tall, undefined for any. */
function declaredWide() {
  const content = document.querySelector('meta[name="game-aspect"]')?.getAttribute("content");
  const match = /^\s*(\d{1,2})\s*[:/x×]\s*(\d{1,2})\s*$/i.exec(content ?? "");
  if (!match || Number(match[1]) === Number(match[2])) {
    return undefined;
  }
  return Number(match[1]) > Number(match[2]);
}

/** One stylesheet for the page, whichever version of this module is loaded. */
function addStyle() {
  let style = document.getElementById("touch-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "touch-style";
    document.head.prepend(style);
  }
  style.textContent = STYLE;
}

/**
 * The layer the page shows on a touch screen, or null where there is no page (a test). `turning`
 * hears when the request to turn the phone covers the game and when it goes.
 */
export function createTouchLayer({ turning } = {}) {
  if (typeof document === "undefined") {
    return null;
  }
  addStyle();
  const element = document.createElement("div");
  element.id = "touch";
  element.hidden = true;
  // Fingers on the controls are the controls': no scrolling, zoom, text selection or the mouse
  // events a browser makes up after a tap (which would also press Mouse0).
  const keep = (event) => event.preventDefault();
  element.addEventListener("touchstart", keep, { passive: false });
  const ui = document.getElementById("ui");
  if (ui) {
    ui.before(element);
  } else {
    document.body.append(element);
  }
  const turn = document.createElement("div");
  turn.className = "touch-turn";
  turn.hidden = true;
  turn.innerHTML = TURN_ICON;
  turn.addEventListener("touchstart", keep, { passive: false });
  document.body.append(turn);

  let shown = false;
  let ring = null;
  let knob = null;
  let wide;
  let asking = false;
  const buttons = new Map();

  /** Covers the game while the phone is held the other way from the game's shape. */
  const checkTurn = () => {
    const ask =
      shown &&
      wide !== undefined &&
      innerWidth !== innerHeight &&
      wide !== innerWidth > innerHeight;
    if (ask !== asking) {
      asking = ask;
      turn.hidden = !ask;
      turning?.(ask);
    }
  };
  addEventListener("resize", checkTurn);

  return {
    element,
    /** Shows the controls while the person plays by touch, hides them otherwise. */
    show(on) {
      shown = on;
      element.hidden = !on;
      checkTurn();
    },
    /** Draws the declared controls, or none (null) until the game declares them again. */
    build(layout, pause = false) {
      element.replaceChildren();
      buttons.clear();
      ring = knob = null;
      wide = layout ? declaredWide() : undefined;
      checkTurn();
      if (!layout) {
        return;
      }
      if (layout.move) {
        const area = document.createElement("div");
        area.className = "touch-area";
        area.dataset.touch = "move";
        area.style.left = "0";
        area.style.width = "50%";
        ring = document.createElement("div");
        ring.className = "touch-stick";
        knob = document.createElement("div");
        knob.className = "touch-knob";
        ring.append(knob);
        element.append(area, ring);
        this.stick(null);
      }
      if (layout.look) {
        const area = document.createElement("div");
        area.className = "touch-area";
        area.dataset.touch = "look";
        area.style.right = "0";
        area.style.width = layout.move ? "50%" : "100%";
        element.append(area);
      }
      const group = document.createElement("div");
      group.className = "touch-buttons";
      for (const { action, label } of layout.buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "touch-button";
        button.dataset.touch = "button";
        button.dataset.action = action;
        button.textContent = label;
        buttons.set(action, button);
        group.append(button);
      }
      element.append(group);
      if (pause) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "touch-pause";
        button.dataset.touch = "button";
        button.dataset.action = "pause";
        button.setAttribute("aria-label", "Pause");
        buttons.set("pause", button);
        element.append(button);
      }
    },
    /** Where a stick that lands at `point` goes: far enough from the edges to show whole. */
    place(point) {
      const margin = 64;
      return {
        x: Math.min(Math.max(point.x, margin), innerWidth - margin),
        y: Math.min(Math.max(point.y, margin), innerHeight - margin),
      };
    },
    /** The stick at `origin` with its thumb at `thumb`, or at rest bottom left (null). */
    stick(origin, thumb = origin) {
      if (!ring || !knob) {
        return;
      }
      ring.style.left = origin ? `${origin.x}px` : "";
      ring.style.top = origin ? `${origin.y}px` : "";
      const dx = origin && thumb ? thumb.x - origin.x : 0;
      const dy = origin && thumb ? thumb.y - origin.y : 0;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      ring.toggleAttribute("data-active", origin !== null);
    },
    press(action, down) {
      buttons.get(action)?.toggleAttribute("data-held", down);
    },
    remove() {
      removeEventListener("resize", checkTurn);
      if (asking) {
        turning?.(false);
      }
      element.remove();
      turn.remove();
    },
  };
}
