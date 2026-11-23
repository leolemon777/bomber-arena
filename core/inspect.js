// Looking into the running game while it is built: freezing its world, pointing at what is in it
// and moving the things a person may move. The app's editor drives it through
// `window.__game.inspect`; a packaged game never loads this file.
//
// Frozen, the game's update() is not called and its frames are still drawn. The pointer and the
// keys then belong to the editor, not the game: a drag turns the camera about the point it looks
// at, the right button or Shift slides it, the wheel moves it closer, and a click picks what is
// under it. On resuming, the camera goes back to where the game had it.
//
// A click is resolved with a THREE.Raycaster against what the camera draws. What it finds is a
// mesh somewhere inside a model; the editor selects the thing it belongs to (core/things.js), or
// for an object the game's code added directly, the outermost object that code added. Objects
// that are hidden, lines, points and the sky are never picked. Each object remembers the line of
// src/ that added it to the scene, so a pointed-at object names its code.
//
//   inspect.read(known)        frozen, speed, mode, what is selected, and the code-made objects
//   inspect.freeze() / resume() / step() / speed(0.25)
//   inspect.select(key) / mode("move" | "turn" | "size") / view() / focus()
//   inspect.describe(key)      a selected thing or object in words an instruction can carry
//
// A key is "t:<thing id>" or "o:<object id>"; x and y are the page's CSS pixels.
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { turnOf, turnPatch } from "./things-ops.js";

const CLICK_SLOP_PX = 4;
const HOVER_EVERY_MS = 60;
const MAX_CODE_ROWS = 200;
const SELECTED = "#c5f955";
const HOVERED = "#ffffff";

const SOURCE = /\/(src\/[^?:)\s]+)(?:\?[^:)\s]*)?:(\d+):\d+/;
/** object → the "src/file.js:line" that added it to its parent. */
const sources = new WeakMap();

/** The file and line of the game's own code in a stack trace, or undefined. */
export function sourceIn(stack) {
  const line = String(stack ?? "")
    .split("\n")
    .find((entry) => entry.includes("/src/"));
  const where = line && SOURCE.exec(line);
  return where ? `${where[1]}:${where[2]}` : undefined;
}

/** From now on every object added to a parent remembers which line of src/ added it. */
function watchSources(Object3D = THREE.Object3D) {
  if (Object3D.prototype.add.watching) {
    return;
  }
  const add = Object3D.prototype.add;
  const watching = function (...objects) {
    // The stack is read only for an object not seen before: one put back, or moved to another
    // parent, already has its line.
    const fresh = objects.filter((object) => object && !sources.has(object));
    const source = fresh.length ? sourceIn(new Error().stack) : undefined;
    if (source) {
      for (const object of fresh) {
        sources.set(object, source);
      }
    }
    return add.apply(this, objects);
  };
  watching.watching = true;
  Object3D.prototype.add = watching;
}

/** Words a line adds its object under that say nothing of what it is. */
const PLAIN = new Set([
  "mesh",
  "group",
  "object",
  "obj",
  "holder",
  "model",
  "light",
  "node",
  "item",
]);

/**
 * The name a line of code gives what it adds: `group.add(gantry)` adds "gantry", and
 * `scene.add(player.holder)` adds "player". Undefined for a line that adds something unnamed
 * (`scene.add(new THREE.Mesh(…))`) or under a word that says nothing (`mesh`).
 */
export function nameIn(line) {
  const added = /\.add\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(String(line ?? ""));
  const words = added?.[1].split(".").filter((word) => word !== "this") ?? [];
  while (words.length > 1 && PLAIN.has(words.at(-1).toLowerCase())) {
    words.pop();
  }
  // `scene.add(buildRoom())` adds a room.
  const made = /^(?:build|create|make|add)([A-Z]\w*)$/.exec(words.at(-1) ?? "");
  const word = made ? made[1][0].toLowerCase() + made[1].slice(1) : words.at(-1);
  // A loop's one-letter variable names nothing either.
  return word && word.length > 2 && !PLAIN.has(word.toLowerCase()) && word !== "new"
    ? word
    : undefined;
}

/** Whether an object is drawn: the Raycaster itself also answers for hidden ones. */
export function shown(object) {
  for (let current = object; current; current = current.parent) {
    if (!current.visible) {
      return false;
    }
  }
  return true;
}

/**
 * The first hit a person can mean: something drawn, with a surface, that is not the sky or one
 * of the editor's own marks.
 */
export function firstPicked(hits, tools) {
  return hits.find(({ object }) => {
    if (object.isLine || object.isPoints || object.name === "sky" || !shown(object)) {
      return false;
    }
    for (let current = object; current; current = current.parent) {
      if (current === tools) {
        return false;
      }
    }
    return true;
  });
}

/** From `object` up to the scene's own child: what a click on it may mean, the part first. */
export function chainOf(object, scene) {
  const chain = [];
  for (let current = object; current && current !== scene; current = current.parent) {
    chain.push(current);
  }
  return chain;
}

/**
 * The whole a click on a part means: the outermost object above it that is not a container of the
 * world. A game often keeps its whole level, or everything, in one group; that group is no answer
 * to a click on one of its walls. `spans(object)` says whether an object is such a container.
 */
export function outermost(object, scene, spans = () => false) {
  const chain = chainOf(object, scene);
  for (let index = chain.length - 1; index > 0; index--) {
    if (!spans(chain[index])) {
      return chain[index];
    }
  }
  return chain[0] ?? object;
}

/**
 * The next click on the same spot: one step from the whole toward the part, and from the part
 * back to the whole, as editors go into a group.
 */
export function deeper(chain, whole, selected) {
  const at = chain.indexOf(selected);
  return at > 0 ? chain[at - 1] : whole;
}

/**
 * What an object is called in the editor: its name, or its type without one. A placed model is
 * named by its file (core/assets.js), which reads as the file's own name: "wooden_crate_02" for
 * "models/ph/wooden_crate_02/wooden_crate_02.gltf".
 */
export function nameOf(object, learned) {
  const name = object.name || learned?.get(sources.get(object)) || object.type;
  return /\.(glb|gltf)$/i.test(name) ? name.replace(/^.*\//, "").replace(/\.[^.]+$/, "") : name;
}

const rounded = (value, digits = 2) => Number(value.toFixed(digits));

/**
 * A rotation's angles as the file keeps them (degrees about x, the vertical and z), read so that
 * they follow from the angles the thing had. One rotation has two sets of angles, and each angle
 * any number of full turns: read alone, a crate leaned 115° comes out as [65, 180, 180]; next to
 * where it started, [0, 0, 0], it is [115, 0, 0].
 */
export function nearTurn(turn, was) {
  const beside = (angles) =>
    angles.map((angle, axis) => {
      const whole = angle - 360 * Math.round((angle - was[axis]) / 360);
      return rounded(whole, 1) + 0;
    });
  const far = (angles) => angles.reduce((sum, angle, axis) => sum + Math.abs(angle - was[axis]), 0);
  const [read, other] = [turn, [180 - turn[0], turn[1] + 180, turn[2] + 180]].map(beside);
  return far(read) <= far(other) ? read : other;
}
const numbers = (vector) => vector.toArray().map((value) => rounded(value));

/** A color as the editor's marks reach the canvas: with no conversion, so given as it shows. */
const shownColor = (style) => new THREE.Color().setStyle(style, THREE.LinearSRGBColorSpace);
const AXES = {
  X: { way: new THREE.Vector3(1, 0, 0), turn: new THREE.Euler(0, 0, -Math.PI / 2) },
  Y: { way: new THREE.Vector3(0, 1, 0), turn: new THREE.Euler(0, 0, 0) },
  Z: { way: new THREE.Vector3(0, 0, 1), turn: new THREE.Euler(Math.PI / 2, 0, 0) },
};
/** How three turns each axis's half ring from the one it builds (TransformControls.js, r187). */
const RING_TURNS = { X: [0, 0, 0], Y: [0, 0, -Math.PI / 2], Z: [0, Math.PI / 2, 0] };

/**
 * The handle as an editor's reads, from three's own (TransformControls r187, whose parts are
 * hairlines in pure red, green and blue): one arrow to an axis instead of one each way, shafts
 * and rings thick enough to see and to hit, quieter colors, and none of the extra rings, lines
 * and markers it draws while a thing is dragged. Its parts are private to three: on a version
 * that keeps them otherwise, the handle stays as that version draws it.
 */
function dressHandle(gizmo) {
  gizmo.setSize(1.15);
  gizmo.setColors?.(
    shownColor("#f0625d"),
    shownColor("#7fd13b"),
    shownColor("#4c8dff"),
    shownColor("#ffe45c"),
  );
  const parts = gizmo._gizmo;
  if (!parts?.gizmo || !parts.picker || !parts.helper) {
    return;
  }
  const along = (mesh, way) => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).dot(way);
  };
  const turned = (geometry, euler) =>
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler));
  for (const mode of ["translate", "rotate", "scale"]) {
    // The line through the axis and the start and end markers of a drag.
    parts.helper[mode]?.clear();
    for (const group of [parts.gizmo[mode], parts.picker[mode]]) {
      for (const part of [...(group?.children ?? [])]) {
        const axis = AXES[part.name];
        // The ring to turn about the view, the ball to turn freely, and the plates that size two
        // axes of a thing that keeps one size.
        const extra = (mode === "rotate" && !axis) || (mode === "scale" && part.name.length === 2);
        // The arrow and the block that point the other way along an axis.
        if (extra || (axis && mode !== "rotate" && along(part, axis.way) < -0.1)) {
          part.removeFromParent();
        }
      }
    }
    for (const part of parts.gizmo[mode]?.children ?? []) {
      const axis = AXES[part.name];
      if (!axis) {
        continue;
      }
      if (mode === "rotate") {
        const ring = new THREE.TorusGeometry(0.5, 0.011, 8, 64, Math.PI);
        ring.rotateY(Math.PI / 2);
        ring.rotateX(Math.PI / 2);
        part.geometry = turned(ring, new THREE.Euler(...RING_TURNS[part.name]));
        continue;
      }
      part.geometry.computeBoundingBox();
      const size = part.geometry.boundingBox.getSize(new THREE.Vector3());
      if (size.dot(axis.way) > 0.3) {
        // The shaft: from the middle to the head.
        const shaft = new THREE.CylinderGeometry(0.011, 0.011, 0.46, 10).translate(0, 0.23, 0);
        part.geometry = turned(shaft, axis.turn);
      } else if (mode === "translate") {
        const head = new THREE.CylinderGeometry(0, 0.05, 0.15, 20).translate(0, 0.53, 0);
        part.geometry = turned(head, axis.turn);
      } else {
        const block = new THREE.BoxGeometry(0.085, 0.085, 0.085).translate(0, 0.5, 0);
        part.geometry = turned(block, axis.turn);
      }
    }
  }
}

/**
 * Writes the marks of a box's eight corners into `positions`: from each corner a short line along
 * each of its three edges, a fifth of the edge long.
 */
function cornerMarks(box, positions) {
  const size = box.getSize(new THREE.Vector3());
  let at = 0;
  for (let corner = 0; corner < 8; corner++) {
    const from = [
      corner & 1 ? box.max.x : box.min.x,
      corner & 2 ? box.max.y : box.min.y,
      corner & 4 ? box.max.z : box.min.z,
    ];
    for (let axis = 0; axis < 3; axis++) {
      const to = [...from];
      to[axis] += (corner & (1 << axis) ? -1 : 1) * size.getComponent(axis) * 0.2;
      positions.setXYZ(at++, ...from);
      positions.setXYZ(at++, ...to);
    }
  }
  positions.needsUpdate = true;
}

export function createInspect({ renderer, camera, things, input, audio, ui }) {
  watchSources();
  const raycaster = new THREE.Raycaster();
  const page = Math.random().toString(36).slice(2, 10);
  let revision = 0;
  let scene;
  // The editor's marks have a scene of their own, drawn over the finished picture: in the game's
  // scene they would pass through its fog, grade and antialiasing and come out thin and dim.
  const overlay = new THREE.Scene();
  const tools = new THREE.Group();
  tools.name = "editor";
  tools.visible = false;
  overlay.add(tools);
  let gizmo;
  let frozen = false;
  let steps = 0;
  let speed = 1;
  let mode = "move";
  /** { thing } or { object }: what the editor has selected. */
  let selected;
  let selectedBox;
  // More things of the file selected with the first, which keeps the handle: they move, turn and
  // size with it, and are copied and taken away with it.
  const also = new Set();
  let alsoBoxes = [];
  let hoveredBox;
  let hovered;
  let heldCamera;
  const pivot = new THREE.Vector3();
  // The revision says the lists changed (the code-made objects, their names, the pictures). What
  // every read carries anyway (frozen, speed, the handle, what is selected) never bumps it, or
  // each click would send the lists and every picture again.
  const touch = () => {
    revision++;
  };

  // A key names a thing of the file ("t:crate-3"), an object ("o:41"), or one copy of an object
  // drawn many times as one ("o:41.7", the eighth).
  const keyOf = (target) => {
    if (target?.thing) {
      return `t:${target.thing.id}`;
    }
    if (!target?.object) {
      return null;
    }
    return `o:${target.object.id}${target.instance === undefined ? "" : `.${target.instance}`}`;
  };
  const objectOf = (target) => target?.thing?.object ?? target?.object;

  function resolve(key) {
    if (typeof key !== "string") {
      return undefined;
    }
    if (key.startsWith("t:")) {
      const thing = things.find(key.slice(2));
      return thing && { thing };
    }
    const [id, copy] = key.startsWith("o:") ? key.slice(2).split(".") : [];
    const object = id && scene?.getObjectById(Number(id));
    if (!object) {
      return undefined;
    }
    return copy === undefined ? { object } : { object, instance: Number(copy) };
  }

  const pointer = (x, y) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((x - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((y - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    );
  };

  /** What is drawn under a point of the page: the hit, and the thing or object it belongs to. */
  function under(x, y) {
    if (!scene) {
      return undefined;
    }
    raycaster.setFromCamera(pointer(x, y), camera);
    raycaster.layers.mask = camera.layers.mask;
    const hit = firstPicked(raycaster.intersectObjects(scene.children, true), tools);
    if (!hit) {
      return undefined;
    }
    const thing = things.of(hit.object);
    if (thing) {
      return { hit, target: { thing } };
    }
    const chain = chainOf(hit.object, scene);
    const whole = outermost(hit.object, scene, spans);
    // One of many copies drawn as one object is marked where it was clicked.
    const instance = whole === hit.object ? hit.instanceId : undefined;
    return { hit, chain, target: { object: whole, instance } };
  }

  // How large the game's world is, measured once each time it is frozen: an object with parts of
  // its own that spans a third of it is a container, not something a click on a part means.
  let extent = 0;
  const sizeBox = new THREE.Box3();
  const sizeOf = new THREE.Vector3();
  const widest = (object) => {
    sizeBox.setFromObject(object).getSize(sizeOf);
    return sizeBox.isEmpty() ? 0 : Math.max(sizeOf.x, sizeOf.y, sizeOf.z);
  };
  function measureWorld() {
    extent = 0;
    for (const child of scene?.children ?? []) {
      if (child !== tools && child.name !== "sky" && shown(child) && !child.isLight) {
        extent = Math.max(extent, widest(child));
      }
    }
  }
  const spans = (object) => object.children.length > 0 && widest(object) > extent * 0.35;

  // The names the game's own lines give what they add, read from those lines once they are asked for.
  const learned = new Map();
  const read = new Set();
  async function learnNames() {
    const wanted = new Map();
    scene?.traverse((object) => {
      const source = sources.get(object);
      if (source && !object.name && !learned.has(source)) {
        const [file, line] = [
          source.slice(0, source.lastIndexOf(":")),
          Number(source.split(":").at(-1)),
        ];
        if (!read.has(file)) {
          wanted.set(file, [...(wanted.get(file) ?? []), line]);
        }
      }
    });
    await Promise.all(
      [...wanted].map(async ([file, lines]) => {
        read.add(file);
        try {
          // The address the stack named, so the lines are the ones it counted.
          const text = await (await fetch(new URL(file, document.baseURI))).text();
          const all = text.split("\n");
          for (const line of lines) {
            const name = nameIn(all[line - 1]);
            if (name) {
              learned.set(`${file}:${line}`, name);
            }
          }
        } catch {
          read.delete(file);
        }
      }),
    );
    if (wanted.size) {
      touch();
    }
  }

  /** How far from `pivot` the way is clear in a direction, up to `reach`, past the thing itself. */
  function roomAlong(direction, object, reach) {
    raycaster.set(pivot, direction);
    raycaster.layers.mask = camera.layers.mask;
    raycaster.far = reach;
    const own = (hit) => {
      for (let current = hit.object; current; current = current.parent) {
        if (current === object) {
          return true;
        }
      }
      return false;
    };
    const hits = raycaster.intersectObjects(scene.children, true).filter((hit) => !own(hit));
    raycaster.far = Infinity;
    return firstPicked(hits, tools)?.distance ?? reach;
  }

  function box(object, color, instance) {
    // Short marks at the eight corners, not the twelve edges: drawn over the picture so they
    // are never lost in the thing's own edges, a whole box would read as a cage around it.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(8 * 3 * 2 * 3), 3),
    );
    const material = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
    // The marks reach the canvas with no color conversion (draw), so the color is given as the
    // canvas shows it.
    material.color.setStyle(color, THREE.LinearSRGBColorSpace);
    const helper = new THREE.LineSegments(geometry, material);
    helper.renderOrder = 1000;
    helper.frustumCulled = false;
    const around = new THREE.Box3();
    const place = new THREE.Matrix4();
    helper.update = () => {
      if (instance !== undefined && object.isInstancedMesh && object.geometry) {
        // One copy of an object drawn many times as one.
        object.geometry.boundingBox ?? object.geometry.computeBoundingBox();
        object.getMatrixAt(instance, place);
        around
          .copy(object.geometry.boundingBox)
          .applyMatrix4(place.premultiply(object.matrixWorld));
      } else {
        around.setFromObject(object);
      }
      cornerMarks(around, geometry.attributes.position);
    };
    helper.update();
    tools.add(helper);
    return helper;
  }

  function mark() {
    selectedBox?.removeFromParent();
    selectedBox = undefined;
    for (const mark of alsoBoxes) {
      mark.removeFromParent();
    }
    alsoBoxes = [];
    gizmo?.detach();
    const object = objectOf(selected);
    if (!frozen || !object || !tools) {
      return;
    }
    selectedBox = box(object, SELECTED, selected.instance);
    alsoBoxes = [...also].map((thing) => box(thing.object, SELECTED));
    // Only a thing of the file can be moved for good: its place is saved where the game reads it.
    if (selected.thing && !selected.thing.temporary && things.panel) {
      gizmo.setMode({ move: "translate", turn: "rotate", size: "scale" }[mode]);
      // A thing moves along the world's lines and turns about its own.
      gizmo.setSpace(mode === "move" ? "world" : "local");
      gizmo.attach(object);
    }
  }

  function hover(target) {
    if (keyOf(target) === keyOf(hovered)) {
      return;
    }
    hovered = target;
    hoveredBox?.removeFromParent();
    hoveredBox = undefined;
    const object = objectOf(target);
    if (object && keyOf(target) !== keyOf(selected)) {
      hoveredBox = box(object, HOVERED, target.instance);
    }
  }

  const editable = (target) => Boolean(target?.thing && !target.thing.temporary);

  /** Selects one, or with `add` puts a thing of the file in or out of what is selected. */
  function select(target, add = false) {
    if (add && editable(target) && editable(selected)) {
      if (target.thing === selected.thing) {
        // The first steps out: another of them takes the handle.
        const [next] = also;
        if (next) {
          also.delete(next);
          target = { thing: next };
        } else {
          target = undefined;
        }
      } else if (also.has(target.thing)) {
        also.delete(target.thing);
        target = selected;
      } else {
        // The one clicked last has the handle.
        also.add(selected.thing);
      }
    } else {
      also.clear();
    }
    selected = target;
    hover(undefined);
    mark();
    const object = objectOf(target);
    if (object) {
      // Its middle, not its origin: a wall's origin may be the far end of the building.
      new THREE.Box3().setFromObject(object).getCenter(pivot);
    }
  }

  /** The dragged holder's place as the file writes it: metres, degrees, one scale. */
  /** Writes what a drag of the handle did to the file; `from` is where the drag began. */
  function commit(from) {
    const thing = selected?.thing;
    if (!thing || !things.panel) {
      return;
    }
    const { position, rotation, scale } = thing.object;
    const now = { at: numbers(position), scale: rounded(scale.x) };
    const was = { at: [0, 0, 0], scale: 1, ...thing.entry };
    // Only what the drag changed is written: a thing never moved keeps no place of its own.
    const patch = Object.fromEntries(
      Object.entries(now).filter(([part, value]) => String(value) !== String(was[part])),
    );
    // A thing kept on the ground has its height from the ground: lifted or lowered by hand, it
    // keeps the height it was given instead of falling back.
    const lifted = rounded(position.y - from.y) !== 0;
    const freed = (entry) => (lifted && entry.ground === true ? { ground: false } : {});
    Object.assign(patch, freed(thing.entry));
    // The holder's angles are read in the order the file keeps them (core/things.js places it so).
    const turn = nearTurn(
      [rotation.x, rotation.y, rotation.z].map((angle) => THREE.MathUtils.radToDeg(angle)),
      turnOf(thing.entry),
    );
    if (String(turn) !== String(turnOf(thing.entry))) {
      Object.assign(patch, turnPatch(turn));
    }
    const ops = Object.keys(patch).length ? [{ op: "set", id: thing.id, patch }] : [];
    // The others selected with it go the same way and as far: one change, one step to take back.
    const moved = numbers(position.clone().sub(from)).some((value) => value !== 0);
    const spun = turn[1] - turnOf(thing.entry)[1];
    const grown = now.scale / was.scale;
    for (const other of ops.length ? also : []) {
      const had = { scale: 1, ...other.entry };
      const next = {};
      if (moved) {
        // It followed the drag in the picture: where it stands now is where it stays.
        Object.assign(next, { at: numbers(other.object.position) }, freed(other.entry));
      }
      if (spun !== 0) {
        const [x, y, z] = turnOf(other.entry);
        Object.assign(next, turnPatch([x, rounded(y + spun, 1), z]));
      }
      if (grown !== 1) {
        next.scale = Math.min(Math.max(rounded(had.scale * grown), 0.01), 1000);
      }
      if (Object.keys(next).length) {
        ops.push({ op: "set", id: other.id, patch: next });
      }
    }
    if (ops.length) {
      things.panel.change(ops);
    }
  }

  // A small picture of one thing of each kind, for the app's list: one made a frame, each kind
  // once for the page's life. The thing is drawn alone, under a plain light, from above its side.
  const THUMB = 96;
  const KINDS_PICTURED = 24;
  const thumbs = new Map();
  let thumbStage;
  function pictureNext() {
    const thing = things
      .all()
      .find((item) => !thumbs.has(item.kind) && item.object.children.length > 0);
    if (!thing || thumbs.size >= KINDS_PICTURED) {
      return;
    }
    thumbs.set(thing.kind, null);
    thumbStage ??= {
      scene: new THREE.Scene(),
      lens: new THREE.PerspectiveCamera(28, 1, 0.01, 2000),
      target: new THREE.RenderTarget(THUMB, THUMB),
    };
    const { scene: stage, lens, target } = thumbStage;
    stage.clear();
    stage.add(new THREE.HemisphereLight("#ffffff", "#5b6470", 2.4));
    const sun = new THREE.DirectionalLight("#ffffff", 2.2);
    sun.position.set(2, 4, 3);
    stage.add(sun);
    const copy = thing.object.clone(true);
    copy.position.set(0, 0, 0);
    stage.add(copy);
    const around = new THREE.Box3().setFromObject(copy);
    if (around.isEmpty()) {
      return;
    }
    const middle = around.getCenter(new THREE.Vector3());
    const reach = around.getSize(new THREE.Vector3()).length() / 2 / Math.sin(Math.PI * (14 / 180));
    lens.position.copy(middle).add(new THREE.Vector3(1, 0.75, 1).setLength(reach));
    lens.lookAt(middle);
    const kept = {
      target: renderer.getRenderTarget(),
      colour: renderer.getClearColor(new THREE.Color()),
      alpha: renderer.getClearAlpha(),
    };
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor("#000000", 0);
      renderer.render(stage, lens);
    } finally {
      renderer.setRenderTarget(kept.target);
      renderer.setClearColor(kept.colour, kept.alpha);
    }
    // The picture is read back a moment later; a kind whose picture cannot be read keeps none.
    void renderer
      .readRenderTargetPixelsAsync(target, 0, 0, THUMB, THUMB)
      .then((pixels) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = THUMB;
        const context = canvas.getContext("2d");
        const image = context.createImageData(THUMB, THUMB);
        // The target holds light as the renderer works with it; a picture holds it as screens do.
        const displayed = (value) => {
          const c = value / 255;
          return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
        };
        const flipped = !renderer.backend?.isWebGPUBackend;
        for (let row = 0; row < THUMB; row++) {
          const from = (flipped ? THUMB - 1 - row : row) * THUMB * 4;
          for (let at = 0; at < THUMB * 4; at += 4) {
            const to = row * THUMB * 4 + at;
            image.data[to] = displayed(pixels[from + at]);
            image.data[to + 1] = displayed(pixels[from + at + 1]);
            image.data[to + 2] = displayed(pixels[from + at + 2]);
            image.data[to + 3] = pixels[from + at + 3];
          }
        }
        context.putImageData(image, 0, 0);
        thumbs.set(thing.kind, canvas.toDataURL("image/webp", 0.85));
        touch();
      })
      .catch(() => {});
  }

  // The file's things changed (an undo, the Agent's edit, a kind swapped). A thing built again is
  // another object and one taken away is none: what is selected is found again by its id, and
  // left alone when it is still the same, since a drag of the handle may be under way.
  things.watch?.(() => {
    const held = selected?.thing ? [selected.thing, ...also] : [];
    const now = held.map((thing) => things.find(thing.id)).filter(Boolean);
    if (held.length === now.length && held.every((thing, index) => thing === now[index])) {
      return;
    }
    const [first, ...rest] = now;
    selected = first && { thing: first };
    also.clear();
    for (const thing of rest) {
      also.add(thing);
    }
    drag = undefined;
    mark();
  });

  /** What is selected of the file's things, the one with the handle first. */
  const chosen = () => (editable(selected) ? [selected.thing, ...also] : []);

  /** Selects the things of these ids, the first with the handle. */
  function choose(ids) {
    const [first, ...rest] = ids.map((id) => things.find(id)).filter(Boolean);
    select(first ? { thing: first } : undefined);
    for (const thing of rest) {
      also.add(thing);
    }
    mark();
  }

  const labelOf = (kind) =>
    things.panel?.read(null).kinds.find((item) => item.name === kind)?.label ?? kind;

  /** A copy of each selected thing beside it, selected in its place. */
  function duplicate() {
    const from = chosen();
    if (!from.length || !things.panel) {
      return false;
    }
    // Beside it as the person sees it: to the right in the picture, on the ground's level.
    const aside = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0);
    const reach = Math.max(widest(from[0].object), 0.5);
    if (aside.lengthSq() > 0) {
      aside.setLength(reach);
    } else {
      aside.set(reach, 0, 0);
    }
    const ids = [];
    const ops = from.map((thing) => {
      // Each id is free of the ones picked a moment ago in this same change.
      const id = things.panel.freeId(thing.kind, ids);
      ids.push(id);
      const at = thing.entry.at ?? [0, 0, 0];
      return {
        op: "add",
        thing: {
          ...thing.entry,
          id,
          name: `${labelOf(thing.kind)} ${id.split("-").at(-1)}`,
          at: [rounded(at[0] + aside.x), at[1], rounded(at[2] + aside.z)],
        },
      };
    });
    if (!things.panel.change(ops)) {
      return false;
    }
    choose(ids);
    return true;
  }

  /** Takes the selected things out of the file; Undo brings them back. */
  function removeChosen() {
    const from = chosen();
    if (!from.length || !things.panel) {
      return false;
    }
    select(undefined);
    return things.panel.change(from.map((thing) => ({ op: "remove", id: thing.id })));
  }

  /** A new thing of a kind where the middle of the picture points, selected. */
  function addThing(kind) {
    if (!things.panel || !scene || typeof kind !== "string") {
      return null;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const found = under(rect.left + rect.width / 2, rect.top + rect.height * 0.55);
    const spot = found
      ? found.hit.point
      : camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8).add(camera.position);
    // As the others of its kind stand: on the ground if they are, at their size.
    const like = things.all(kind).find((thing) => !thing.temporary)?.entry;
    const ground = like?.ground ?? things.height?.(spot.x, spot.z) !== undefined;
    const id = things.panel.freeId(kind);
    const thing = {
      id,
      kind,
      name: `${labelOf(kind)} ${id.split("-").at(-1)}`,
      at: numbers(spot),
      ...(ground ? { ground: true } : {}),
      ...(like?.scale ? { scale: like.scale } : {}),
    };
    if (!things.panel.change([{ op: "add", thing }])) {
      return null;
    }
    choose([id]);
    return keyOf(selected);
  }

  // The camera while frozen: it turns about `pivot`, slides with it and moves along its own line.
  const offset = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const turned = new THREE.Quaternion();
  const tilted = new THREE.Quaternion();
  const orbit = (dx, dy) => {
    // The camera goes round the pivot and turns by as much, so the picture swings about the
    // pivot where it is on screen; looking at the pivot instead would jump it to the middle.
    turned.setFromAxisAngle(UP, -dx * 0.005);
    tilted.setFromAxisAngle(offset.setFromMatrixColumn(camera.matrixWorld, 0), -dy * 0.005);
    // Not over the top or under the bottom, where left and right would swap.
    if (Math.abs(camera.getWorldDirection(offset).applyQuaternion(tilted).y) < 0.985) {
      turned.multiply(tilted);
    }
    offset.copy(camera.position).sub(pivot).applyQuaternion(turned);
    camera.position.copy(pivot).add(offset);
    camera.quaternion.premultiply(turned);
  };
  const slide = (dx, dy) => {
    const reach = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom / Math.max(renderer.domElement.clientHeight, 1)
      : camera.position.distanceTo(pivot) * 0.0015;
    const move = new THREE.Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(-dx * reach)
      .add(
        new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(dy * reach),
      );
    camera.position.add(move);
    pivot.add(move);
  };
  const dolly = (amount) => {
    const factor = Math.exp(amount * 0.001);
    if (camera.isOrthographicCamera) {
      camera.zoom = THREE.MathUtils.clamp(camera.zoom / factor, 0.05, 200);
      camera.updateProjectionMatrix();
      return;
    }
    offset.copy(camera.position).sub(pivot);
    if (offset.length() * factor > 0.2) {
      camera.position.copy(pivot).add(offset.multiplyScalar(factor));
    }
  };
  const holdCamera = () => {
    heldCamera = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
    heldCamera.zoom = camera.zoom;
    // It turns about what it looks at: the first surface straight ahead, or a spot ten metres on.
    const rect = renderer.domElement.getBoundingClientRect();
    const ahead = under(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (ahead) {
      pivot.copy(ahead.hit.point);
    } else {
      camera.getWorldDirection(pivot).multiplyScalar(10).add(camera.position);
    }
  };
  const giveCameraBack = () => {
    if (!heldCamera) {
      return;
    }
    camera.position.copy(heldCamera.position);
    camera.quaternion.copy(heldCamera.quaternion);
    if (camera.zoom !== heldCamera.zoom) {
      camera.zoom = heldCamera.zoom;
      camera.updateProjectionMatrix();
    }
    heldCamera = undefined;
  };

  // The pointer and keys while frozen. They are taken before the game's own listeners see them.
  let drag;
  let lastHover = 0;
  const taken = (event) => {
    event.stopImmediatePropagation();
    if (event.cancelable) {
      event.preventDefault();
    }
  };
  const onDown = (event) => {
    taken(event);
    const at = Object.assign(pointer(event.clientX, event.clientY), { button: event.button });
    drag = { x: event.clientX, y: event.clientY, moved: false, kind: "turn" };
    if (event.button === 0 && gizmo.object) {
      gizmo.pointerHover(at);
      if (gizmo.axis) {
        // The handle's drag plane follows the handle only when the gizmo is next laid out.
        gizmo.getHelper().updateMatrixWorld(true);
        gizmo.pointerDown(at);
        drag.kind = "gizmo";
        drag.scale = gizmo.object.scale.x;
        drag.from = gizmo.object.position.clone();
        drag.others = [...also].map((thing) => [thing, thing.object.position.clone()]);
        return;
      }
    }
    if (event.button !== 0 || event.shiftKey) {
      drag.kind = "slide";
    }
  };
  const onMove = (event) => {
    taken(event);
    // A move carries no button, as the gizmo expects of one.
    const at = Object.assign(pointer(event.clientX, event.clientY), { button: -1 });
    if (!drag) {
      if (gizmo.object) {
        gizmo.pointerHover(at);
      }
      const now = performance.now();
      if (now - lastHover >= HOVER_EVERY_MS) {
        lastHover = now;
        hover(gizmo.axis ? undefined : under(event.clientX, event.clientY)?.target);
      }
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) {
      return;
    }
    drag.moved = true;
    if (drag.kind === "gizmo") {
      gizmo.pointerMove(at);
      if (mode === "move") {
        const place = gizmo.object.position;
        for (const [thing, from] of drag.others) {
          thing.object.position.copy(from).add(place).sub(drag.from);
        }
      }
      if (mode === "size") {
        // A thing keeps one size: whichever handle is pulled, the whole thing follows it.
        const { scale } = gizmo.object;
        const pulled = [scale.x, scale.y, scale.z].reduce((far, value) =>
          Math.abs(value - drag.scale) > Math.abs(far - drag.scale) ? value : far,
        );
        scale.setScalar(Math.min(Math.max(pulled, 0.01), 1000));
      }
      return;
    }
    (drag.kind === "turn" ? orbit : slide)(event.movementX, event.movementY);
  };
  const onUp = (event) => {
    taken(event);
    const ended = drag;
    drag = undefined;
    if (!ended) {
      return;
    }
    if (ended.kind === "gizmo") {
      gizmo.pointerUp(Object.assign(pointer(event.clientX, event.clientY), { button: 0 }));
      if (ended.moved) {
        commit(ended.from);
      }
      return;
    }
    if (!ended.moved && event.button === 0) {
      const found = under(event.clientX, event.clientY);
      // A second click where the selection already is goes one step into it.
      const within = found?.chain && selected?.object && found.chain.includes(selected.object);
      if (event.shiftKey) {
        // Shift adds a thing to what is selected, or takes it out; on nothing it changes nothing.
        if (found) {
          select(found.target, true);
        }
      } else {
        select(
          within
            ? { object: deeper(found.chain, found.target.object, selected.object) }
            : found?.target,
        );
      }
      if (found) {
        // The camera then turns about the spot that was clicked, which is in view.
        pivot.copy(found.hit.point);
      }
    }
  };
  const onWheel = (event) => {
    taken(event);
    dolly(event.deltaY);
  };
  // The keys an editor's hand knows: W, E and R for the handle, F to bring the selection into view.
  const KEYS = { w: "move", e: "turn", r: "size" };
  const onKey = (event) => {
    // A key with Command or Control is the window's (reload, the developer tools): the game does
    // not get it, and the editor does not stop what the window does with it.
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === "d" && things.panel) {
        taken(event);
        if (event.type === "keydown") {
          duplicate();
        }
        return;
      }
      if (event.key.toLowerCase() === "z" && things.panel) {
        // Undo and redo are the editor's while the game is frozen.
        taken(event);
        if (event.type === "keydown") {
          things.panel[event.shiftKey ? "redo" : "undo"]();
        }
        return;
      }
      event.stopImmediatePropagation();
      return;
    }
    taken(event);
    if (event.type !== "keydown" || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "escape") {
      select(undefined);
    } else if (KEYS[key]) {
      hooks.mode(KEYS[key]);
    } else if (key === "f") {
      hooks.focus();
    } else if (key === "delete" || key === "backspace") {
      // Out of the file, and back with Undo. A thing made while playing is the game's to remove.
      removeChosen();
    }
  };
  const LISTENERS = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["wheel", onWheel],
    ...["mousedown", "mouseup", "click", "dblclick", "contextmenu"].map((type) => [type, taken]),
    ...["keydown", "keyup"].map((type) => [type, onKey]),
  ];
  const listen = (on) => {
    for (const [type, listener] of LISTENERS) {
      window[on ? "addEventListener" : "removeEventListener"](type, listener, {
        capture: true,
        passive: false,
      });
    }
  };

  function freeze() {
    if (frozen || !scene) {
      return frozen;
    }
    frozen = true;
    document.exitPointerLock?.();
    // Held keys are let go; the game's own bindings stay for when it plays again.
    input?.clear?.();
    void audio?.context?.suspend?.();
    holdCamera();
    measureWorld();
    void learnNames();
    tools.visible = true;
    // The game's own display lies over the picture and is not what is being edited.
    ui?.style.setProperty("visibility", "hidden");
    listen(true);
    mark();
    return true;
  }

  function resume() {
    if (!frozen) {
      return false;
    }
    frozen = false;
    steps = 0;
    drag = undefined;
    listen(false);
    hover(undefined);
    mark();
    tools.visible = false;
    ui?.style.removeProperty("visibility");
    giveCameraBack();
    void audio?.context?.resume?.();
    return true;
  }

  /** The objects the game's code added to the scene itself, one row for each line that adds. */
  function codeRows() {
    const rows = new Map();
    for (const object of scene?.children ?? []) {
      if (object === tools || object.userData?.thing !== undefined) {
        continue;
      }
      const source = sources.get(object) ?? null;
      const group = source ?? `o:${object.id}`;
      const row = rows.get(group);
      if (row) {
        row.count++;
      } else if (rows.size < MAX_CODE_ROWS) {
        rows.set(group, {
          key: `o:${object.id}`,
          name: nameOf(object, learned),
          type: object.type,
          source,
          count: 1,
        });
      }
    }
    return [...rows.values()];
  }

  const hooks = {
    read(known) {
      const head = {
        revision: `${page}:${revision}:${scene?.children.length ?? 0}`,
        frozen,
        speed,
        mode,
        selected: keyOf(selected),
        also: [...also].map((thing) => `t:${thing.id}`),
      };
      if (known === head.revision) {
        return head;
      }
      const pictured = [...thumbs].filter(([, picture]) => picture);
      return { ...head, code: codeRows(), thumbs: Object.fromEntries(pictured) };
    },
    freeze,
    resume,
    /** One sixtieth of a second of the game, while frozen. */
    step() {
      if (frozen) {
        steps++;
      }
      return frozen;
    },
    speed(next) {
      if (Number.isFinite(next) && next > 0 && next <= 4) {
        speed = next;
      }
      return speed;
    },
    mode(next) {
      if (["move", "turn", "size"].includes(next)) {
        mode = next;
        mark();
      }
      return mode;
    },
    select(key, add = false) {
      select(resolve(key), add === true);
      return keyOf(selected);
    },
    /** A new thing of a kind, where the middle of the picture points; answers its key. */
    add: addThing,
    duplicate,
    remove: removeChosen,
    /** Back to the camera as the game had it, still frozen. */
    view() {
      if (frozen) {
        giveCameraBack();
        holdCamera();
      }
      return frozen;
    },
    /** Brings the selected thing to the middle of the picture. */
    focus() {
      const object = objectOf(selected);
      if (!frozen || !object) {
        return false;
      }
      const bounds = new THREE.Box3().setFromObject(object);
      const reach = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1) * 1.5;
      bounds.getCenter(pivot);
      // From where the thing can be seen whole: along the line the camera already looks down, as
      // editors frame a selection, unless a wall stands in that line; then from the first side
      // of it that is clear, or the clearest, a little above.
      const ways = [camera.getWorldDirection(new THREE.Vector3()).negate()];
      for (let turn = 0; turn < 8; turn++) {
        const angle = (turn * Math.PI) / 4;
        ways.push(new THREE.Vector3(Math.cos(angle), 0.45, Math.sin(angle)).normalize());
      }
      let best = { way: ways[0], room: 0 };
      for (const way of ways) {
        const room = roomAlong(way, object, reach);
        if (room > best.room) {
          best = { way, room };
        }
        if (room >= reach) {
          break;
        }
      }
      camera.position.copy(pivot).addScaledVector(best.way, best.room * 0.92);
      camera.lookAt(pivot);
      return true;
    },
    /** What a key names, as plain data an instruction to the Agent can carry. */
    describe(key) {
      const target = resolve(key);
      const object = objectOf(target);
      if (!object) {
        return null;
      }
      const source = sources.get(object);
      // The others the same line added, in the order it added them: "the second of three" tells
      // the Agent which pass of a loop made this one.
      const same = source
        ? (object.parent?.children ?? []).filter((peer) => sources.get(peer) === source)
        : [object];
      const peers = same.length;
      return {
        key,
        name: nameOf(object, learned),
        type: object.type,
        thing: target.thing?.temporary === false ? target.thing.id : null,
        kind: target.thing?.kind ?? null,
        temporary: target.thing?.temporary ?? false,
        model: target.thing?.model?.holder.name ?? null,
        source: source ?? null,
        peers,
        nth: same.indexOf(object) + 1,
        copy: target.instance === undefined ? null : target.instance + 1,
        copies: object.isInstancedMesh ? object.count : null,
      };
    },
  };

  return {
    hooks,
    frozen: () => frozen,
    /** The time the game's update() gets this frame, or null for none. */
    advance(delta) {
      if (!frozen) {
        return delta * speed;
      }
      if (steps > 0) {
        steps--;
        return 1 / 60;
      }
      return null;
    },
    /** Once a frame: the marks follow what they mark. */
    frame() {
      selectedBox?.update();
      hoveredBox?.update();
      for (const box of alsoBoxes) {
        box.update();
      }
    },
    /** After the frame is drawn: the marks go over it, through nothing the picture goes through. */
    draw() {
      if (frozen) {
        pictureNext();
      }
      if (!frozen || !(selectedBox || hoveredBox || gizmo?.object)) {
        return;
      }
      // Straight onto the canvas, as the post chain's own last step goes: with the renderer's
      // tone mapping or color conversion on, a render passes through a buffer of its own and
      // would replace the picture instead of lying on it.
      const { autoClear, toneMapping, outputColorSpace } = renderer;
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      try {
        renderer.render(overlay, camera);
      } finally {
        Object.assign(renderer, { autoClear, toneMapping, outputColorSpace });
      }
    },
    /** A new version of the game has a new scene: the marks move to it, a selected thing stays. */
    attach(nextScene) {
      const key = keyOf(selected);
      scene = nextScene;
      // One gizmo for the page's life, fed by the listeners above instead of an element of its own.
      if (!gizmo) {
        gizmo = new TransformControls(camera);
        dressHandle(gizmo);
        tools.add(gizmo.getHelper());
      }
      gizmo.detach();
      selectedBox?.removeFromParent();
      hoveredBox?.removeFromParent();
      selectedBox = hoveredBox = hovered = undefined;
      also.clear();
      selected = key?.startsWith("t:") ? resolve(key) : undefined;
      // A new version's lines are not the old one's: the names read from them are read again.
      learned.clear();
      read.clear();
      if (frozen) {
        void learnNames();
      }
      mark();
      touch();
    },
    dispose() {
      resume();
      gizmo?.detach();
      selectedBox?.removeFromParent();
      hoveredBox?.removeFromParent();
      selectedBox = hoveredBox = undefined;
    },
  };
}
