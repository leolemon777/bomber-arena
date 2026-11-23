// Procedural effects, drawn in code rather than modelled: blast flames, crate splinters, the fuse
// spark, pick-up rings and the puff of a defeated bomber.
import * as THREE from "three";
import { float, mix, positionLocal, sin, time, uniform, uv, vec3 } from "three/tsl";

/** A tile's centre in the world: the board is centred on the origin, one tile per metre. */
export function tileToWorld(c, r, W, H, y = 0) {
  return new THREE.Vector3(c - (W - 1) / 2, y, r - (H - 1) / 2);
}

/** Unlit glow is divided by the scene's exposure, so it shows at its own brightness at any hour. */
let exposure = float(1);
let sharedRingGeo = null;
let sharedRingMat = null;
export function setExposureNode(node) {
  exposure = node;
  if (sharedRingMat) {
    sharedRingMat.dispose();
    sharedRingMat = null;
  }
}

function flameMaterial(core, edge, opacity) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: opacity < 1, depthWrite: opacity >= 1 });
  // Hot at the middle of each piece, cooler at its ends, flickering along its length.
  const along = positionLocal.x.abs().max(positionLocal.z.abs());
  const flicker = sin(time.mul(38).add(positionLocal.x.mul(9)).add(positionLocal.z.mul(7))).mul(0.12).add(0.88);
  m.colorNode = mix(vec3(...core), vec3(...edge), along.mul(1.6).clamp(0, 1)).mul(flicker).div(exposure);
  m.opacityNode = float(opacity);
  return m;
}

export function createFx(scene, W, H) {
  const root = new THREE.Group();
  root.name = "fx";
  scene.add(root);

  const capsule = new THREE.CapsuleGeometry(0.34, 0.5, 6, 14);
  capsule.rotateZ(Math.PI / 2); // lying along x
  const ball = new THREE.SphereGeometry(0.5, 20, 14);
  const outer = flameMaterial([2.4, 0.75, 0.08], [1.6, 0.22, 0.02], 0.92);
  const inner = flameMaterial([3.2, 2.6, 1.1], [2.6, 1.3, 0.15], 1);

  const flames = []; // { group, t, life }
  const chips = []; // { mesh, v, spin, t }
  const puffs = [];

  const chipGeo = new THREE.BoxGeometry(0.16, 0.07, 0.3);
  const chipMat = new THREE.MeshStandardMaterial({ color: "#e98a35", roughness: 0.55 });
  const puffMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, transparent: true });

  return {
    /** One explosion: a burst on the bomb's tile and a tube of fire along each arm. */
    blast(tiles, life) {
      const group = new THREE.Group();
      for (const tile of tiles) {
        const p = tileToWorld(tile.c, tile.r, W, H, 0.42);
        if (!tile.arm) {
          const a = new THREE.Mesh(ball, outer);
          a.scale.setScalar(1.05);
          const b = new THREE.Mesh(ball, inner);
          b.scale.setScalar(0.6);
          a.position.copy(p);
          b.position.copy(p);
          a.userData.base = a.scale.clone();
          b.userData.base = b.scale.clone();
          a.userData.ball = b.userData.ball = true;
          group.add(a, b);
          continue;
        }
        const yaw = tile.arm[0] !== 0 ? 0 : Math.PI / 2;
        for (const [mat, s] of [
          [outer, 1],
          [inner, 0.55],
        ]) {
          const m = new THREE.Mesh(capsule, mat);
          m.position.copy(p);
          m.rotation.y = yaw;
          // The arm's last tile is a rounded tip that does not reach past the tile.
          m.scale.set(tile.end ? 0.85 : 1.25, s, s);
          if (tile.end) m.position.add(new THREE.Vector3(-tile.arm[0], 0, -tile.arm[1]).multiplyScalar(0.08));
          m.userData.base = m.scale.clone();
          group.add(m);
        }
      }
      root.add(group);
      flames.push({ group, t: 0, life });
    },

    /** Splinters of a broken crate, flying and falling. */
    splinter(c, r) {
      const p = tileToWorld(c, r, W, H, 0.5);
      for (let i = 0; i < 9; i++) {
        const mesh = new THREE.Mesh(chipGeo, chipMat);
        mesh.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.3, (Math.random() - 0.5) * 0.5));
        mesh.castShadow = true;
        const v = new THREE.Vector3((Math.random() - 0.5) * 5, 3 + Math.random() * 3, (Math.random() - 0.5) * 5);
        root.add(mesh);
        chips.push({ mesh, v, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, 0), t: 0 });
      }
    },

    /** A soft white puff where a bomber was knocked out. */
    puff(position) {
      for (let i = 0; i < 7; i++) {
        const m = new THREE.Mesh(ball, puffMat.clone());
        m.position.copy(position).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6));
        m.scale.setScalar(0.1);
        root.add(m);
        puffs.push({ mesh: m, t: 0, grow: 0.45 + Math.random() * 0.35 });
      }
    },

    update(dt) {
      for (let i = flames.length - 1; i >= 0; i--) {
        const f = flames[i];
        f.t += dt;
        const k = f.t / f.life;
        // Burst out fast, hold, then pinch away.
        const s = k < 0.15 ? 0.2 + (k / 0.15) * 0.9 : k < 0.7 ? 1.1 - (k - 0.15) * 0.18 : Math.max(0.01, 1 - (k - 0.7) / 0.3);
        for (const m of f.group.children) {
          const b = m.userData.base;
          if (m.userData.ball) m.scale.copy(b).multiplyScalar(s);
          else m.scale.set(b.x * Math.min(1, 0.4 + s), b.y * s, b.z * s);
        }
        if (f.t >= f.life) {
          root.remove(f.group);
          flames.splice(i, 1);
        }
      }
      for (let i = chips.length - 1; i >= 0; i--) {
        const c = chips[i];
        c.t += dt;
        c.v.y -= 16 * dt;
        c.mesh.position.addScaledVector(c.v, dt);
        if (c.mesh.position.y < 0.04) {
          c.mesh.position.y = 0.04;
          c.v.multiplyScalar(0.4);
          c.v.y = Math.abs(c.v.y) * 0.3;
        }
        c.mesh.rotation.x += c.spin.x * dt;
        c.mesh.rotation.y += c.spin.y * dt;
        c.mesh.scale.setScalar(Math.max(0.01, 1 - Math.max(0, c.t - 0.5) / 0.4));
        if (c.t > 0.9) {
          root.remove(c.mesh);
          chips.splice(i, 1);
        }
      }
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.t += dt;
        p.mesh.scale.setScalar(0.1 + p.grow * Math.min(1, p.t / 0.35));
        p.mesh.position.y += dt * 0.6;
        p.mesh.material.opacity = Math.max(0, 1 - p.t / 0.8);
        if (p.t > 0.8) {
          root.remove(p.mesh);
          p.mesh.material.dispose();
          puffs.splice(i, 1);
        }
      }
    },

    clear() {
      for (const f of flames) root.remove(f.group);
      for (const c of chips) root.remove(c.mesh);
      for (const p of puffs) {
        root.remove(p.mesh);
        p.mesh.material.dispose();
      }
      flames.length = chips.length = puffs.length = 0;
    },

    dispose() {
      for (const p of puffs) p.mesh.material.dispose();
      puffs.length = 0;
      scene.remove(root);
      capsule.dispose();
      ball.dispose();
      chipGeo.dispose();
      outer.dispose();
      inner.dispose();
      chipMat.dispose();
      puffMat.dispose();
    },
  };
}

/** A pulsing glow ring that marks a power-up on the floor. */
export function makeRing() {
  if (!sharedRingGeo) sharedRingGeo = new THREE.PlaneGeometry(0.9, 0.9);
  if (!sharedRingMat) {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    m.blending = THREE.AdditiveBlending;
    const d = uv().sub(0.5).length().mul(2);
    const band = d.sub(0.78).abs().mul(-14).add(1).clamp(0, 1);
    const pulse = sin(time.mul(4)).mul(0.25).add(0.75);
    m.colorNode = vec3(1.6, 1.35, 0.6).mul(band).mul(pulse).div(exposure);
    sharedRingMat = m;
  }
  const mesh = new THREE.Mesh(sharedRingGeo, sharedRingMat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  return mesh;
}

export { uniform };
