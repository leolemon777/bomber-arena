// Rapier physics for three.js games, imported only by games that need it. Collision never uses the
// detailed visual mesh: characters are capsules, props are boxes, spheres or convex hulls, and only
// fixed level geometry uses a triangle mesh, built from its collision version (a further-reduced
// copy of the model, models/<name>-collision.glb).
//
//   const physics = createPhysics();
//   physics.fixed(levelCollisionObject)                     static triangle mesh; never moves
//   const crate = physics.body(crateHolder, { shape: "box", size: [1, 1, 1] })   moves crateHolder
//   physics.body(liftHolder, { shape: "box", size: [4, 0.5, 4], kinematic: true })
//                            a lift, door or moving platform: move liftHolder like any object and
//                            the body follows, carrying characters on it, pushing those in its way
//   const hero = physics.character(heroHolder, { radius: 0.35, height: 1.7 })
//   hero.move({ x, y, z })   metres this frame, gravity included; slides along walls, climbs steps
//                            returns whether the hero stood on ground at the last physics step
//   physics.step(delta)                                     fixed 60 Hz steps, then syncs holders
//   physics.dispose()                                       in the game's dispose()
//
// Holders that physics moves (dynamic bodies, characters) move smoothly at any frame rate: each is
// placed between the last two physics steps by the time left over. Move the camera after
// physics.step, from the holders it placed, or it trails them by a frame. The world belongs to one
// game version: a new version builds its bodies again from save().
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

await RAPIER.init();
export { RAPIER };

const STEP = 1 / 60;
const MAX_STEPS = 5;

/** World-space triangles of every mesh under `object`, as one Rapier trimesh's arrays. */
export function triangles(object) {
  object.updateMatrixWorld(true);
  const positions = [];
  const indices = [];
  const point = new THREE.Vector3();
  object.traverse((child) => {
    if (!child.isMesh) {
      return;
    }
    const geometry = child.geometry;
    const position = geometry.attributes.position;
    const offset = positions.length / 3;
    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);
      positions.push(point.x, point.y, point.z);
    }
    if (geometry.index) {
      for (const index of geometry.index.array) {
        indices.push(offset + index);
      }
    } else {
      for (let index = 0; index < position.count; index += 1) {
        indices.push(offset + index);
      }
    }
  });
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const turnFrom = new THREE.Quaternion();
const turnTo = new THREE.Quaternion();
const mix = (from, to, alpha) => from + (to - from) * alpha;

export function createPhysics({ gravity = -9.81 } = {}) {
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  world.timestep = STEP;
  const synced = [];
  const characters = [];
  // Kinematic bodies and where each was sent at the latest step; each step moves it a share of
  // the way to its holder, so a frame with no step (a display faster than 60 Hz) loses no travel.
  const driven = [];
  let accumulator = 0;

  /** A holder that follows `body`, from where the body stood before the latest step. */
  const follow = (holder, body, positionOnly = false) => {
    synced.push({
      holder,
      body,
      positionOnly,
      previous: body.translation(),
      previousRotation: body.rotation(),
    });
  };

  const shapeDesc = (shape, size) => {
    if (shape === "sphere") {
      return RAPIER.ColliderDesc.ball(size[0]);
    }
    if (shape === "capsule") {
      // Rapier's half height is the straight part's; size[1] is the whole capsule's height.
      return RAPIER.ColliderDesc.capsule(Math.max(size[1] / 2 - size[0], 0.01), size[0]);
    }
    return RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
  };

  return {
    world,
    RAPIER,
    /**
     * Fixed geometry from `object` (its collision version), as one static triangle mesh, copied
     * where `object` stands now; it never moves.
     */
    fixed(object) {
      const { vertices, indices } = triangles(object);
      return world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
    },
    /**
     * A moving body for `holder`; shape box ([w, h, d]), sphere ([r]) or capsule ([r, h]). A
     * dynamic body moves the holder. A kinematic one follows the holder as the game moves it.
     */
    body(holder, { shape = "box", size = [1, 1, 1], kinematic = false, mass } = {}) {
      const position = holder.position;
      const desc = (
        kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic()
      )
        .setTranslation(position.x, position.y, position.z)
        .setRotation(holder.quaternion);
      const body = world.createRigidBody(desc);
      const collider = shapeDesc(shape, size);
      if (mass !== undefined) {
        collider.setMass(mass);
      }
      // A sphere's centre sits its radius, a box's or capsule's half its height, above the holder's
      // feet.
      const lift = shape === "sphere" ? size[0] : size[1] / 2;
      world.createCollider(collider.setTranslation(0, lift, 0), body);
      if (kinematic) {
        driven.push({
          holder,
          body,
          position: holder.position.clone(),
          rotation: holder.quaternion.clone(),
        });
      } else {
        follow(holder, body);
      }
      return body;
    },
    /**
     * A character the game steers: a kinematic capsule moved by Rapier's character controller,
     * which slides along walls, climbs steps and snaps to the ground.
     */
    character(holder, { radius = 0.35, height = 1.7, step = 0.35, slope = 50 } = {}) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
          holder.position.x,
          holder.position.y,
          holder.position.z,
        ),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.capsule(Math.max(height / 2 - radius, 0.01), radius).setTranslation(
          0,
          height / 2,
          0,
        ),
        body,
      );
      const controller = world.createCharacterController(0.02);
      controller.enableAutostep(step, radius, true);
      controller.enableSnapToGround(step);
      controller.setMaxSlopeClimbAngle((slope * Math.PI) / 180);
      follow(holder, body, true);
      // Motion waits here until a physics step takes it: a frame with no step (a display faster
      // than 60 Hz) keeps its motion for the next one instead of losing it.
      const pending = { x: 0, y: 0, z: 0 };
      let grounded = false;
      characters.push((share) => {
        const motion = { x: pending.x * share, y: pending.y * share, z: pending.z * share };
        pending.x -= motion.x;
        pending.y -= motion.y;
        pending.z -= motion.z;
        controller.computeColliderMovement(collider, motion);
        const corrected = controller.computedMovement();
        const current = body.translation();
        body.setNextKinematicTranslation({
          x: current.x + corrected.x,
          y: current.y + corrected.y,
          z: current.z + corrected.z,
        });
        grounded = controller.computedGrounded();
      });
      return {
        body,
        /**
         * Moves by `motion` metres this frame, at the next physics steps; returns whether the
         * character stood on ground at the last one.
         */
        move(motion) {
          pending.x += motion.x;
          pending.y += motion.y;
          pending.z += motion.z;
          return grounded;
        },
      };
    },
    /**
     * Advances in fixed 60 Hz steps, sharing each character's motion and each kinematic body's
     * way to its holder out across them, and places each dynamic body's and character's holder
     * between its body's last two steps by the time left over.
     */
    step(delta) {
      accumulator = Math.min(accumulator + delta, STEP * MAX_STEPS);
      const steps = Math.floor(accumulator / STEP);
      accumulator -= steps * STEP;
      for (let index = 0; index < steps; index += 1) {
        const share = 1 / (steps - index);
        // Kinematic bodies move first, so the characters' controller sees where they are going.
        for (const entry of driven) {
          entry.position.lerp(entry.holder.position, share);
          entry.rotation.slerp(entry.holder.quaternion, share);
          entry.body.setNextKinematicTranslation(entry.position);
          entry.body.setNextKinematicRotation(entry.rotation);
        }
        for (const advance of characters) {
          advance(share);
        }
        for (const entry of synced) {
          entry.previous = entry.body.translation();
          entry.previousRotation = entry.body.rotation();
        }
        world.step();
      }
      const alpha = accumulator / STEP;
      for (const { holder, body, positionOnly, previous, previousRotation } of synced) {
        const now = body.translation();
        holder.position.set(
          mix(previous.x, now.x, alpha),
          mix(previous.y, now.y, alpha),
          mix(previous.z, now.z, alpha),
        );
        if (!positionOnly) {
          const rotation = body.rotation();
          turnFrom.set(
            previousRotation.x,
            previousRotation.y,
            previousRotation.z,
            previousRotation.w,
          );
          turnTo.set(rotation.x, rotation.y, rotation.z, rotation.w);
          holder.quaternion.slerpQuaternions(turnFrom, turnTo, alpha);
        }
      }
    },
    dispose() {
      world.free();
    },
  };
}
