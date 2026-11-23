// A picture of the game without its HUD and text, for the game's card and page on a site that
// lists it. window.__game.picture(true) hides them and picture(false) brings them back as they
// were; the game goes on running in between. What is hidden:
//
//   - the #ui layer, where a game's screens and HUD stand;
//   - in a Phaser game, every text object and every object marked as HUD, by
//     object.setData("hud", true) or the name "hud" (a container hides with what it holds);
//   - whatever the game itself hides in picture(on), when what createGame returned has one: a
//     score drawn in the three.js scene, a crosshair sprite.
//
// The game keeps running while a picture is taken, so nothing here is hidden by a value the
// game's own code sets each frame: the layer by its opacity, which no child can turn back on,
// and a Phaser object by whether it is drawn at all, leaving its `visible` to the game. Calling
// picture(true) again hides what has appeared since. It answers what it hid, so whoever takes
// the picture knows what was left to the game.

/** Hides a page element without moving anything around it; answers how to bring it back. */
export function hideElement(element) {
  const style = element?.style;
  if (typeof style?.setProperty !== "function") {
    return undefined;
  }
  const value = style.getPropertyValue("opacity");
  const priority = style.getPropertyPriority("opacity");
  style.setProperty("opacity", "0", "important");
  return () => {
    if (value) {
      style.setProperty("opacity", value, priority);
    } else {
      style.removeProperty("opacity");
    }
  };
}

const PHASER_TEXT = new Set(["Text", "BitmapText", "DynamicBitmapText", "DOMElement"]);

const isHud = (object) =>
  PHASER_TEXT.has(object.type) || object.name === "hud" || object.getData?.("hud") === true;

const notDrawn = () => false;

/**
 * Keeps the text and HUD objects of every scene of a Phaser game from being drawn. Phaser asks
 * each object willRender() before it draws it; the object answers no while the picture is taken,
 * whatever the game sets its `visible` to meanwhile, and answers for itself again afterwards.
 * `again()` takes in the objects made since. Answers how many it holds and how to let them go.
 */
export function hidePhaserHud(game) {
  const held = new Set();
  const nodes = new Set();
  const elements = [];
  // A DOM element stands in the page, outside what Phaser draws: not drawing it, or the container
  // it is in, leaves it where it was.
  const hideNodes = (object) => {
    if (object.type === "DOMElement" && !nodes.has(object)) {
      nodes.add(object);
      const restore = hideElement(object.node);
      if (restore) {
        elements.push(restore);
      }
    }
    for (const child of Array.isArray(object.list) ? object.list : []) {
      hideNodes(child);
    }
  };
  const visit = (objects) => {
    for (const object of objects ?? []) {
      if (isHud(object)) {
        if (!held.has(object)) {
          held.add(object);
          object.willRender = notDrawn;
        }
        // Asked again, a held container gives up the elements put in it since.
        hideNodes(object);
      } else if (Array.isArray(object.list)) {
        // A container or a layer: what it holds may be HUD even when it is not.
        visit(object.list);
      }
    }
  };
  const scan = () => {
    for (const scene of game?.scene?.getScenes?.(false) ?? []) {
      visit(scene.children?.list);
    }
    return held.size;
  };
  scan();
  return {
    get count() {
      return held.size;
    },
    again: scan,
    restore() {
      for (const object of held) {
        // Only what was put there is taken away: the object's own answer is on its prototype.
        if (object.willRender === notDrawn) {
          delete object.willRender;
        }
      }
      held.clear();
      nodes.clear();
      for (const restore of elements.splice(0)) {
        restore();
      }
    },
  };
}

/**
 * The switch itself. `layers()` is called when a picture starts and hides what the runtime knows
 * of; it answers `{ hidden(), restore(), again?() }`, where hidden() lists what is hidden now and
 * again() hides what has appeared since. `game()` answers what createGame returned, whose own
 * picture(on) hides what only the game knows of. Turning it on twice hides once, and takes in
 * what is new. A game whose picture() throws leaves the switch as it would be without one: the
 * runtime's layers are hidden and come back, and `error` carries what the game said.
 */
export function createPicture({ layers, game = () => undefined }) {
  let active;
  const ask = (own, on) => {
    if (typeof own?.picture !== "function") {
      return undefined;
    }
    try {
      own.picture(on);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return (on = true) => {
    if (on && !active) {
      const layer = layers();
      const own = game();
      const error = ask(own, true);
      active = { layer, own, error, asked: typeof own?.picture === "function" };
    } else if (on) {
      active.layer.again?.();
    } else if (active) {
      const { layer, own, error } = active;
      active = undefined;
      layer.restore();
      const failed = ask(own, false) ?? error;
      return { on: false, hidden: [], ...(failed ? { error: failed } : {}) };
    }
    if (!active) {
      return { on: false, hidden: [] };
    }
    return {
      on: true,
      hidden: [
        ...active.layer.hidden(),
        ...(active.asked && !active.error ? ["what the game hides itself"] : []),
      ],
      ...(active.error ? { error: active.error } : {}),
    };
  };
}
