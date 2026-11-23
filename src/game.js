// 炸弹乱斗: a grid bomber in the Bomb It / Crazy Arcade mould. One player against up to three bots;
// bombs blast in a cross, chain into each other and break crates, which drop power-ups.
//
//   export function createGame({ scene, camera, renderer, lighting, state, flow, input, audio, tuning, things, ui })
//     → { update(delta), save(), dispose() }
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { hue, mix, smoothstep, texture, vec4, max as tslMax, sin, time, vec3 } from "three/tsl";
import { placeModel } from "../core/assets.js";
import { damp } from "../core/motion.js";
import { createFx, makeRing, setExposureNode, tileToWorld } from "./fx.js";
import { createHud } from "./hud.js";
import {
  CRATE,
  EMPTY,
  H,
  SPAWNS,
  W,
  blastTiles,
  canEscape,
  dangerMap,
  idx,
  makeBoard,
  pathTo,
  rng,
  search,
} from "./rules.js";

const MODEL = {
  hero: "assets/char_bomber_red.glb",
  bomb: "assets/prop_bomb_classic.glb",
  crate: "assets/env_block_crate.glb",
  wall: "assets/env_wall_bumper.glb",
  shoe: "assets/item_powerup_sneaker.glb",
  potion: "assets/item_powerup_potion.glb",
};

const ROSTER = [
  { name: "你", css: "#e8322f", hue: 0, spawn: 3 },
  { name: "蓝蓝", css: "#2f6fe8", hue: 4.0, spawn: 2 },
  { name: "绿绿", css: "#27b04f", hue: 2.15, spawn: 0 },
  { name: "黄黄", css: "#f2b81d", hue: 0.85, spawn: 1 },
];
const MAX_SPEED_LV = 6;
const MAX_RANGE = 8;
const MAX_BOMBS = 8;

const SFX = {
  place: [1.2, , 320, 0.01, 0.03, 0.08, 1, 1.6, , , , , , , , , , 0.6, 0.02],
  boom: [1.6, , 90, 0.02, 0.12, 0.5, 4, 2.6, , , , , , 1.4, , 0.5, 0.1, 0.42, 0.12],
  pick: [1.1, , 660, 0.01, 0.06, 0.16, 1, 1.4, , , 260, 0.05, , , , , , 0.6, 0.03],
  out: [1.3, , 420, 0.02, 0.08, 0.38, 2, 2, -6, , , , , 0.4, , , , 0.5, 0.1],
  win: [1.3, , 520, 0.02, 0.2, 0.4, 1, 1.2, , , 300, 0.08, 0.08],
};

/** Recolors the red parts of a bomber's texture to a team color, leaving white, skin and gold. */
function tint(model, shift) {
  if (!shift) return;
  model.traverse((o) => {
    if (!o.isMesh || !o.material?.map) return;
    const src = o.material;
    const m = new THREE.MeshStandardNodeMaterial({
      map: src.map,
      normalMap: src.normalMap,
      normalScale: src.normalScale,
      roughnessMap: src.roughnessMap,
      metalnessMap: src.metalnessMap,
      roughness: src.roughness,
      metalness: src.metalness,
      side: src.side,
    });
    const t = texture(src.map);
    const c = t.rgb;
    const redness = c.r.sub(tslMax(c.g, c.b));
    const mask = smoothstep(0.28, 0.45, redness);
    m.colorNode = vec4(mix(c, hue(c, shift), mask), t.a);
    o.material = m;
  });
}

export function createGame({ scene, camera, lighting, state, flow, input, audio, tuning, ui }) {
  // --- Light and camera -----------------------------------------------------------------------
  lighting.setTime(11.5);
  lighting.setGrade("warm");
  lighting.setStyle("painted");
  lighting.setWeather?.({ clouds: 0.05 });
  lighting.setEnvironment?.({ fog: false });
  if (lighting.look?.exposure) setExposureNode(lighting.look.exposure);

  // --- The board ------------------------------------------------------------------------------
  const level = new THREE.Group();
  level.name = "arena";
  scene.add(level);

  const tileGeo = new RoundedBoxGeometry(0.97, 0.24, 0.97, 2, 0.06);
  const tileMat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 });
  const floor = new THREE.InstancedMesh(tileGeo, tileMat, W * H);
  floor.receiveShadow = true;
  const tileA = new THREE.Color("#f1e6cf");
  const tileB = new THREE.Color("#9db0c4");
  const m4 = new THREE.Matrix4();
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const p = tileToWorld(c, r, W, H, -0.12);
      m4.makeTranslation(p.x, p.y, p.z);
      floor.setMatrixAt(idx(c, r), m4);
      floor.setColorAt(idx(c, r), (c + r) % 2 ? tileB : tileA);
    }
  }
  level.add(floor);

  // The world past the arena: a wide pastel plinth so the board floats on something.
  const plinth = new THREE.Mesh(
    new RoundedBoxGeometry(W + 1.4, 0.6, H + 1.4, 3, 0.3),
    new THREE.MeshStandardMaterial({ color: "#5f86ad", roughness: 0.6 }),
  );
  plinth.position.y = -0.48;
  plinth.receiveShadow = true;
  level.add(plinth);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 48), new THREE.MeshStandardMaterial({ color: "#86b4dc", roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.8;
  ground.receiveShadow = true;
  scene.add(ground);
  lighting.setLevel?.(level);

  // Prototype models: the runtime loaded them behind the loading screen; each use is a clone.
  const proto = {};
  for (const [key, path] of Object.entries(MODEL)) {
    if (key === "hero") continue;
    proto[key] = placeModel(path, new THREE.Group()).holder;
  }
  const cloneOf = (key) => {
    const h = proto[key].clone(true);
    h.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return h;
  };

  /**
   * Many copies of one model in a few draw calls: one InstancedMesh per mesh of the model, one
   * instance per tile. set(i, position, yaw, scale) places tile i's copy; scale 0 hides it.
   */
  function instanced(key, parent, tiles) {
    const holder = proto[key];
    holder.updateMatrixWorld(true);
    const parts = [];
    const slot = new Map(tiles.map((t, k) => [t, k]));
    holder.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, Math.max(1, tiles.length));
      im.count = tiles.length;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      parent.add(im);
      parts.push({ im, local: o.matrixWorld.clone() });
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const s = new THREE.Vector3();
    return {
      set(tile, position, yaw, scale) {
        const i = slot.get(tile);
        if (i === undefined) return;
        q.setFromAxisAngle(up, yaw);
        m.compose(position, q, s.setScalar(scale));
        for (const p of parts) {
          p.im.setMatrixAt(i, scale > 0 ? m.clone().multiply(p.local) : m.makeScale(0, 0, 0));
          p.im.instanceMatrix.needsUpdate = true;
        }
      },
      dispose() {
        for (const p of parts) parent.remove(p.im);
      },
    };
  }

  // Walls never change: the border and the pillars.
  const fixed = makeBoard(0, () => 1);
  const walls = instanced("wall", level, [...fixed.keys()].filter((i) => fixed[i] === 1));
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (fixed[idx(c, r)] !== 1) continue;
      walls.set(idx(c, r), tileToWorld(c, r, W, H), ((c * 7 + r * 3) % 4) * (Math.PI / 2), 1);
    }
  }

  const fx = createFx(scene, W, H);
  const itemLayer = new THREE.Group();
  const bombLayer = new THREE.Group();
  scene.add(itemLayer, bombLayer);
  let crateSet = null;
  const crateYaw = (i) => (i % 4) * (Math.PI / 2);

  // --- Bombers ----------------------------------------------------------------------------------
  const actors = ROSTER.map((def, i) => {
    const holder = new THREE.Group();
    scene.add(holder);
    const placed = placeModel(MODEL.hero, holder, {
      onReplace: (res) => setupModel(actor, res),
    });
    const actor = { ...def, i, holder, placed, isPlayer: i === 0, alive: true, x: 0, z: 0, yaw: 0, path: [], think: 0, moving: false };
    placed.ready.then((res) => setupModel(actor, res));
    return actor;
  });

  function setupModel(a, { model, animations }) {
    tint(model, a.hue);
    a.mixer = new THREE.AnimationMixer(model);
    const clip = (name) => THREE.AnimationClip.findByName(animations, name) ?? animations[0];
    a.idle = a.mixer.clipAction(clip("Idle"));
    a.run = a.mixer.clipAction(clip("Run"));
    a.idle.play();
    a.run.play();
    a.run.weight = 0;
    a.idle.time = Math.random() * 2;
  }

  // --- Round state ------------------------------------------------------------------------------
  let cells;

  let bombs = []; // { c, r, t, range, owner, holder, spark }
  let flames = []; // { c, r, t }
  let items = []; // { c, r, kind, holder, t }
  let pending = []; // items waiting for the flame to clear: { c, r, kind, t }
  let timeLeft = 180;
  let endTimer = -1;
  let startGrace = 0;
  let shake = 0;
  let seed = state.seed ?? (Math.random() * 1e9) | 0;
  const breaking = []; // crates popping: { i, t }

  function newRound(keep) {
    breaking.length = 0;
    for (const b of bombs) bombLayer.remove(b.holder);
    for (const it of items) itemLayer.remove(it.holder);
    bombs = [];
    flames = [];
    items = [];
    pending = [];
    fx.clear();
    if (!keep) seed = (Math.random() * 1e9) | 0;
    cells = keep?.cells ? Uint8Array.from(keep.cells) : makeBoard(tuning.get("crate.density"), rng(seed));
    crateSet?.dispose();
    crateSet = instanced("crate", level, [...cells.keys()].filter((i) => cells[i] === CRATE));
    for (let i = 0; i < cells.length; i++) {
      crateSet.set(i, tileToWorld(i % W, (i / W) | 0, W, H), crateYaw(i), cells[i] === CRATE ? 1 : 0);
    }
    const count = 1 + Math.round(tuning.get("bot.count"));
    actors.forEach((a, i) => {
      const saved = keep?.actors?.[i];
      const [c, r] = SPAWNS[a.spawn];
      Object.assign(a, {
        alive: i < count && (saved ? saved.alive : true),
        inRound: i < count,
        x: saved?.x ?? c,
        z: saved?.z ?? r,
        bombsMax: saved?.bombsMax ?? 1,
        range: saved?.range ?? 2,
        speedLv: saved?.speedLv ?? 0,
        active: 0,
        path: [],
        think: Math.random() * 0.3,
        dying: 0,
      });
      a.yaw = 0;
      a.holder.visible = a.alive;
      a.holder.scale.setScalar(1);
      a.holder.rotation.set(0, 0, 0);
    });
    timeLeft = keep?.timeLeft ?? tuning.get("round.time");
    endTimer = -1;
    hud.setActors(actors.filter((a) => a.inRound));
  }

  // --- Helpers ------------------------------------------------------------------------------------
  const bombAt = (c, r) => bombs.find((b) => b.c === c && b.r === r);
  const free = (c, r) => cells[idx(c, r)] === EMPTY && !bombAt(c, r);
  const tileOf = (a) => [Math.round(a.x), Math.round(a.z)];
  const speedOf = (a) => (a.isPlayer ? tuning.get("player.speed") : tuning.get("bot.speed")) + a.speedLv * tuning.get("speed.bonus");

  /** Moves along one axis by up to `dist`, lining up with the lane first, with corner help. */
  function moveAxis(a, axis, s, dist) {
    const other = axis === "x" ? "z" : "x";
    const along = Math.round(a[axis]);
    const lane = Math.round(a[other]);
    const ahead = (k, l) => (axis === "x" ? free(k, l) : free(l, k));
    const off = a[other] - lane;
    if (ahead(along + s, lane)) {
      const align = Math.min(Math.abs(off), dist);
      a[other] -= Math.sign(off) * align;
      a[axis] += s * (dist - align);
      return dist > 0;
    }
    // Blocked in this lane: slip round a corner into the neighbouring lane if that one is open.
    const alt = lane + Math.sign(off);
    if (Math.abs(off) > 0.12 && ahead(along + s, alt) && ahead(along, alt)) {
      a[other] += Math.sign(off) * Math.min(dist, Math.abs(alt - a[other]));
      return true;
    }
    const before = a[axis];
    const goal = along;
    const next = a[axis] + s * dist;
    a[axis] = s > 0 ? Math.min(next, Math.max(a[axis], goal)) : Math.max(next, Math.min(a[axis], goal));
    const align = Math.min(Math.abs(off), dist);
    a[other] -= Math.sign(off) * align;
    return Math.abs(a[axis] - before) > 1e-4 || align > 1e-4;
  }

  function placeBomb(a) {
    const [c, r] = tileOf(a);
    if (a.active >= a.bombsMax || bombAt(c, r) || cells[idx(c, r)] !== EMPTY) return false;
    const holder = cloneOf("bomb");
    holder.position.copy(tileToWorld(c, r, W, H));
    const spark = new THREE.Mesh(sparkGeo, sparkMat);
    spark.position.set(-0.15, 0.74, 0);
    holder.add(spark);
    bombLayer.add(holder);
    bombs.push({ c, r, t: tuning.get("bomb.fuse"), fuse: tuning.get("bomb.fuse"), range: a.range, owner: a, holder });
    a.active++;
    audio.sfx(SFX.place, { volume: a.isPlayer ? 0.8 : 0.35 });
    return true;
  }
  const sparkGeo = new THREE.SphereGeometry(0.07, 10, 8);
  const sparkMat = new THREE.MeshBasicNodeMaterial();
  sparkMat.colorNode = vec3(6, 2.6, 0.5)
    .mul(sin(time.mul(40)).mul(0.35).add(0.75))
    .div(lighting.look?.exposure ?? 1);

  function explode(b) {
    bombs = bombs.filter((x) => x !== b);
    bombLayer.remove(b.holder);
    b.owner.active = Math.max(0, b.owner.active - 1);
    const life = tuning.get("flame.time");
    const tiles = blastTiles(cells, (c, r) => bombAt(c, r), b.c, b.r, b.range);
    for (const tile of tiles) {
      const i = idx(tile.c, tile.r);
      if (cells[i] === CRATE) {
        cells[i] = EMPTY;
        breaking.push({ i, t: 0 });
        fx.splinter(tile.c, tile.r);
        if (Math.random() < tuning.get("drop.chance")) {
          const roll = Math.random();
          pending.push({ c: tile.c, r: tile.r, kind: roll < 0.36 ? "bomb" : roll < 0.72 ? "fire" : "shoe", t: life * 0.9 });
        }
      }
      const other = bombAt(tile.c, tile.r);
      if (other) other.t = Math.min(other.t, 0.06);
      items = items.filter((it) => {
        if (it.c === tile.c && it.r === tile.r && it.age > 0.3) {
          itemLayer.remove(it.holder);
          return false;
        }
        return true;
      });
      flames.push({ c: tile.c, r: tile.r, t: life });
    }
    fx.blast(tiles, life);
    shake = Math.min(0.35, shake + 0.16);
    audio.sfx(SFX.boom, { volume: 0.55, pitch: 0.9 + Math.random() * 0.2 });
  }



  function spawnItem(p) {
    const key = p.kind === "bomb" ? "bomb" : p.kind === "fire" ? "potion" : "shoe";
    const holder = new THREE.Group();
    const model = cloneOf(key);
    if (p.kind === "bomb") model.scale.setScalar(0.85);
    holder.add(model);
    const ring = makeRing();
    holder.add(ring);
    holder.position.copy(tileToWorld(p.c, p.r, W, H));
    itemLayer.add(holder);
    items.push({ c: p.c, r: p.r, kind: p.kind, holder, model, age: 0 });
  }

  function knockOut(a) {
    if (!a.alive) return;
    a.alive = false;
    a.dying = 0.001;
    fx.puff(a.holder.position);
    audio.sfx(SFX.out, { volume: a.isPlayer ? 0.9 : 0.5 });
  }

  // --- Bots -------------------------------------------------------------------------------------
  function decide(a) {
    const [c, r] = tileOf(a);
    const here = idx(c, r);
    const danger = dangerMap(cells, bombs, flames);
    const bombSet = new Set(bombs.map((b) => idx(b.c, b.r)));
    bombSet.delete(here);
    const perStep = 1 / speedOf(a);
    a.path = [];
    if (danger[here] !== Infinity) {
      const { dist, prev } = search(cells, bombSet, c, r, (i, steps) => danger[i] > steps * perStep + 0.12);
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < dist.length; i++) {
        if (dist[i] < 0) continue;
        const score = danger[i] === Infinity ? dist[i] : 100 - danger[i];
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0) a.path = pathTo(prev, best);
      a.fleeing = true;
      return;
    }
    a.fleeing = false;
    const aggr = tuning.get("bot.aggression");
    const enemies = actors.filter((e) => e !== a && e.alive);
    const reach = blastTiles(cells, (tc, tr) => Boolean(bombAt(tc, tr)), c, r, a.range);
    const hitsCrate = reach.some((t) => cells[idx(t.c, t.r)] === CRATE);
    const hitsEnemy = reach.some((t) => enemies.some((e) => tileOf(e)[0] === t.c && tileOf(e)[1] === t.r));
    if (
      a.active < a.bombsMax &&
      !bombAt(c, r) &&
      (hitsCrate || (hitsEnemy && Math.random() < 0.35 + aggr * 0.6)) &&
      canEscape(cells, bombs, flames, c, r, a.range, tuning.get("bomb.fuse"), speedOf(a))
    ) {
      placeBomb(a);
      decide(a);
      return;
    }
    const { dist, prev } = search(cells, bombSet, c, r, (i) => danger[i] === Infinity);
    let best = here;
    let bestScore = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] < 0) continue;
      const tc = i % W;
      const tr = (i / W) | 0;
      let score = dist[i] + Math.random() * 0.8;
      if (items.some((it) => it.c === tc && it.r === tr)) score -= 9;
      if (a.active < a.bombsMax) {
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => cells[idx(tc + dc, tr + dr)] === CRATE);
        if (near) score -= 2.5;
        const closest = Math.min(...enemies.map((e) => Math.abs(tileOf(e)[0] - tc) + Math.abs(tileOf(e)[1] - tr)), 99);
        score += closest * aggr * 0.45;
      }
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    a.path = best === here ? [] : pathTo(prev, best);
    a.think = a.path.length ? 0.6 : 0.25 + Math.random() * 0.3;
  }

  function steerBot(a, dt) {
    a.think -= dt;
    const [c, r] = tileOf(a);
    const atCentre = Math.abs(a.x - c) < 0.04 && Math.abs(a.z - r) < 0.04;
    if (!a.path.length || (atCentre && a.think <= 0)) {
      if (atCentre || !a.path.length) decide(a);
    }
    const next = a.path[0];
    if (next === undefined) return [0, 0];
    const nc = next % W;
    const nr = (next / W) | 0;
    if (!free(nc, nr) && !(nc === c && nr === r)) {
      a.path = [];
      return [0, 0];
    }
    if (!a.fleeing) {
      const danger = dangerMap(cells, bombs, flames)[next];
      if (danger < 1 / speedOf(a) + tuning.get("flame.time")) {
        a.path = [];
        return [0, 0];
      }
    }
    const dx = nc - a.x;
    const dz = nr - a.z;
    if (Math.abs(dx) < 0.03 && Math.abs(dz) < 0.03) {
      a.x = nc;
      a.z = nr;
      a.path.shift();
      return [0, 0];
    }
    return Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0, Math.abs(dx)] : [0, Math.sign(dz), Math.abs(dz)];
  }

  // --- HUD and flow -------------------------------------------------------------------------------
  const start = () => {
    if (flow.state === "ready") flow.start();
    else if (flow.state === "over") flow.restart();
  };
  const hud = createHud(ui, { onStart: start });
  input.touch({ move: true, look: false, buttons: [{ action: "action", label: "炸弹" }] });

  const offs = [
    flow.on("restart", () => newRound()),
    flow.on("change", ({ to }) => {
      if (to === "playing") {
        hud.hide();
        startGrace = 0.25;
      } else if (to === "paused") hud.paused(true);
      else if (to === "over") hud.result(flow.result);
    }),
    tuning.action?.("restart", () => flow.restart()),
  ];

  newRound(state.cells ? state : null);
  if (flow.state === "ready") hud.start();
  else if (flow.state === "over") hud.result(flow.result ?? "draw");
  else if (flow.state === "paused") hud.paused(true);
  else hud.hide();

  // --- Camera fit: the whole arena in view, under the HUD ----------------------------------------
  const target = new THREE.Vector3(0, 0, 0.7);
  const pitch = THREE.MathUtils.degToRad(56);
  camera.fov = 38;
  let fitted = -1;
  const corners = [];
  for (const x of [-W / 2 - 0.3, W / 2 + 0.3]) for (const y of [0, 1]) for (const z of [-H / 2 - 0.2, H / 2 + 0.3]) corners.push(new THREE.Vector3(x, y, z));
  function fitCamera() {
    camera.updateProjectionMatrix();
    let lo = 6;
    let hi = 80;
    const v = new THREE.Vector3();
    for (let k = 0; k < 24; k++) {
      const d = (lo + hi) / 2;
      camera.position.set(target.x, target.y + Math.sin(pitch) * d, target.z + Math.cos(pitch) * d);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      const ok = corners.every((p) => {
        v.copy(p).project(camera);
        return Math.abs(v.x) < 0.96 && v.y < 0.8 && v.y > -0.95;
      });
      if (ok) hi = d;
      else lo = d;
    }
    return hi;
  }
  let distance = fitCamera();

  function finish(kind) {
    if (endTimer >= 0) return;
    endTimer = kind === "win" ? 1.0 : 1.4;
    finish.kind = kind;
  }

  // --- Frame ------------------------------------------------------------------------------------
  const api = {
    update(delta) {
      const dt = Math.min(delta, 1 / 20);
      if (camera.aspect !== fitted) {
        fitted = camera.aspect;
        distance = fitCamera();
      }
      const playing = flow.state === "playing";
      if (!playing && (flow.state === "ready" || flow.state === "over") && input.pressed("action")) start();

      if (playing) {
        startGrace -= dt;
        timeLeft -= dt;
        // Bombs tick, then go off.
        for (const b of [...bombs]) {
          b.t -= dt;
          if (b.t <= 0) explode(b);
        }
        // Flames burn; anything in one is knocked out, and a bomb in one chains off quickly.
        for (const f of flames) f.t -= dt;
        flames = flames.filter((f) => f.t > 0);
        const flameSet = new Set(flames.map((f) => idx(f.c, f.r)));
        for (const b of [...bombs]) if (flameSet.has(idx(b.c, b.r))) b.t = Math.min(b.t, 0.06);
        for (const a of actors) {
          if (!a.alive) continue;
          const [c, r] = tileOf(a);
          if (flameSet.has(idx(c, r))) knockOut(a);
        }
        for (const p of pending) p.t -= dt;
        for (const p of pending.filter((p) => p.t <= 0)) spawnItem(p);
        pending = pending.filter((p) => p.t > 0);

        // Movement.
        for (const a of actors) {
          if (!a.alive) continue;
          let dir = [0, 0];
          const step = speedOf(a) * dt;
          let dist = step;
          if (a.isPlayer) {
            const v = input.vector();
            const sx = Math.abs(v.x) > 0.3 ? Math.sign(v.x) : 0;
            const sz = Math.abs(v.y) > 0.3 ? -Math.sign(v.y) : 0;
            if (sx && sz) dir = Math.abs(v.x) >= Math.abs(v.y) ? [sx, 0] : [0, sz];
            else dir = [sx, sz];
            if (startGrace <= 0 && input.pressed("action")) placeBomb(a);
            a.moving = false;
            if (dir[0] || dir[1]) {
              a.moving = dir[0] ? moveAxis(a, "x", dir[0], dist) : moveAxis(a, "z", dir[1], dist);
              // Pressing both: try the other way when the first is blocked.
              if (!a.moving && sx && sz) a.moving = dir[0] ? moveAxis(a, "z", sz, dist) : moveAxis(a, "x", sx, dist);
            }
          } else {
            const s = steerBot(a, dt);
            dir = [s[0], s[1]];
            if (s[2] !== undefined) dist = Math.min(step, s[2]);
            a.moving = dir[0] || dir[1] ? (dir[0] ? moveAxis(a, "x", dir[0], dist) : moveAxis(a, "z", dir[1], dist)) : false;
          }
          if (a.moving) a.yawGoal = Math.atan2(dir[0], dir[1]);
          // Power-ups.
          const [c, r] = tileOf(a);
          items = items.filter((it) => {
            if (it.c !== c || it.r !== r) return true;
            if (it.kind === "bomb") a.bombsMax = Math.min(MAX_BOMBS, a.bombsMax + 1);
            if (it.kind === "fire") a.range = Math.min(MAX_RANGE, a.range + 1);
            if (it.kind === "shoe") a.speedLv = Math.min(MAX_SPEED_LV, a.speedLv + 1);
            itemLayer.remove(it.holder);
            audio.sfx(SFX.pick, { volume: a.isPlayer ? 0.8 : 0.3, pitch: a.isPlayer ? 1 : 0.8 });
            return false;
          });
        }

        // The round's end.
        const player = actors[0];
        const bots = actors.filter((a) => a.inRound && !a.isPlayer && a.alive);
        if (endTimer < 0) {
          if (!player.alive) finish(bots.length ? "lose" : "draw");
          else if (!bots.length) finish("win");
          else if (timeLeft <= 0) finish("draw");
        } else {
          endTimer -= dt;
          if (endTimer <= 0) {
            if (finish.kind === "win") audio.sfx(SFX.win);
            flow.end(finish.kind);
          }
        }
      }

      // Bombers: place, face, animate, fall over.
      for (const a of actors) {
        if (!a.inRound) {
          a.holder.visible = false;
          continue;
        }
        a.holder.position.copy(tileToWorld(a.x, a.z, W, H));
        if (a.yawGoal !== undefined) {
          let d = a.yawGoal - a.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          a.yaw += d * (1 - Math.exp(-18 * dt));
        }
        a.holder.rotation.y = a.yaw;
        if (a.mixer) {
          const run = a.alive && a.moving && playing ? 1 : 0;
          a.run.weight = damp(a.run.weight, run, 14, dt);
          a.idle.weight = 1 - a.run.weight;
          a.run.timeScale = speedOf(a) / 3.2;
          a.mixer.update(dt);
        }
        if (!a.alive && a.dying > 0) {
          a.dying += dt;
          const k = Math.min(1, a.dying / 0.6);
          a.holder.rotation.y = a.yaw + k * 12;
          a.holder.position.y = Math.sin(k * Math.PI) * 0.8;
          a.holder.scale.setScalar(Math.max(0.001, 1 - k));
          if (k >= 1) {
            a.holder.visible = false;
            a.dying = 0;
          }
        }
      }

      // Bombs swell faster as the fuse runs down.
      for (const b of bombs) {
        const k = 1 - b.t / b.fuse;
        const beat = Math.sin((b.fuse - b.t) * (6 + k * 22));
        b.holder.scale.set(1 + beat * 0.06 * (0.4 + k), 1 - beat * 0.05 * (0.4 + k), 1 + beat * 0.06 * (0.4 + k));
      }
      for (const it of items) {
        it.age += dt;
        const pop = Math.min(1, it.age / 0.25);
        it.model.position.y = 0.22 + Math.sin(it.age * 3.2) * 0.07;
        it.model.rotation.y += dt * 1.6;
        it.holder.scale.setScalar(pop < 1 ? 0.3 + pop * 0.85 : 1);
      }
      for (let i = breaking.length - 1; i >= 0; i--) {
        const br = breaking[i];
        br.t += dt;
        const k = Math.min(1, br.t / 0.22);
        const pos = tileToWorld(br.i % W, (br.i / W) | 0, W, H);
        crateSet.set(br.i, pos, crateYaw(br.i), k >= 1 ? 0 : Math.max(0.001, 1 + k * 0.25 - k * k * 1.25));
        if (k >= 1) breaking.splice(i, 1);
      }
      fx.update(dt);

      // Camera, with a little shake on each blast.
      shake = Math.max(0, shake - dt * 1.4);
      camera.position.set(target.x, target.y + Math.sin(pitch) * distance, target.z + Math.cos(pitch) * distance);
      camera.lookAt(target);
      if (shake > 0) {
        camera.position.x += (Math.random() - 0.5) * shake * 0.5;
        camera.position.y += (Math.random() - 0.5) * shake * 0.3;
      }

      hud.tick(actors.filter((a) => a.inRound), timeLeft);
      tuning.report?.("round.left", `${Math.ceil(timeLeft)} 秒`);
    },
    save() {
      return {
        seed,
        cells: Array.from(cells),
        timeLeft,
        actors: actors.map((a) => ({ x: a.x, z: a.z, alive: a.alive, bombsMax: a.bombsMax, range: a.range, speedLv: a.speedLv })),
      };
    },
    dispose() {
      offs.forEach((off) => typeof off === "function" && off());
      hud.dispose();
      fx.dispose();
      walls.dispose();
      crateSet?.dispose();
    },
  };
  return api;
}
