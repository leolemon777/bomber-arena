#!/usr/bin/env node
// Versions of the game the person can go back to. Run from the game's folder:
//
//   node core/snapshot.mjs save "<what the person asked for>"
//   node core/snapshot.mjs list
//   node core/snapshot.mjs restore <number>
//
// A snapshot copies the code, what the person wants (design.md), the art direction, the tuning and
// the asset manifest into .versions/<number>/. Models are not copied: a regenerated model gets a
// new file name, so the files a snapshot refers to stay in public/models/. A model or archive left
// in a copied folder is skipped too, and a restore leaves it where it is: one detailed model in
// art/ would otherwise add its size to every snapshot. Restoring first saves the current state, so
// a restore can itself be undone.
import { cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEPT = [
  "src",
  "index.html",
  "design.md",
  "art",
  "public/tuning.json",
  "public/things.json",
  "public/assets.json",
];
const WORKING = /\.(glb|gltf|fbx|obj|stl|blend|usdz|zip)$/i;
const copied = (path) => !WORKING.test(path);

/** Removes what a snapshot holds of `path`, leaving models and archives in place. */
async function clear(path) {
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    return;
  }
  if (!info.isDirectory()) {
    if (copied(path)) {
      await rm(path, { force: true });
    }
    return;
  }
  for (const name of await readdir(path)) {
    await clear(join(path, name));
  }
  // A folder still holding a model stays.
  await rmdir(path).catch(() => undefined);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function snapshots(root) {
  const versions = join(root, ".versions");
  if (!(await exists(versions))) {
    return [];
  }
  const names = (await readdir(versions)).filter((name) => /^\d+$/.test(name));
  const entries = [];
  for (const name of names) {
    try {
      entries.push(JSON.parse(await readFile(join(versions, name, "snapshot.json"), "utf8")));
    } catch {
      // A folder without its record is an interrupted save; it is not listed.
    }
  }
  return entries.sort((a, b) => a.number - b.number);
}

export async function save(message, root = process.cwd()) {
  const list = await snapshots(root);
  const number = (list.at(-1)?.number ?? 0) + 1;
  const folder = join(root, ".versions", String(number));
  await mkdir(folder, { recursive: true });
  for (const path of KEPT) {
    if (await exists(join(root, path))) {
      await cp(join(root, path), join(folder, path), { recursive: true, filter: copied });
    }
  }
  const models = (await exists(join(root, "public/models")))
    ? (await readdir(join(root, "public/models"), { recursive: true })).map(String).sort()
    : [];
  const record = { number, message, time: new Date().toISOString(), models };
  await writeFile(join(folder, "snapshot.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function list(root = process.cwd()) {
  return snapshots(root);
}

export async function restore(number, root = process.cwd()) {
  const record = (await snapshots(root)).find((entry) => entry.number === number);
  if (!record) {
    throw new Error(`There is no snapshot ${number}; run list to see them.`);
  }
  const before = await save(`before restoring ${number}`, root);
  const folder = join(root, ".versions", String(number));
  for (const path of KEPT) {
    const source = join(folder, path);
    const target = join(root, path);
    if (await exists(source)) {
      await clear(target);
      await cp(source, target, { recursive: true });
    }
  }
  return { restored: record, saved: before };
}

async function main([command, argument]) {
  if (command === "save") {
    const record = await save(argument ?? "");
    console.log(`Saved snapshot ${record.number}: ${record.message}`);
  } else if (command === "list") {
    for (const entry of await list()) {
      console.log(`${entry.number}\t${entry.time}\t${entry.message}`);
    }
  } else if (command === "restore") {
    const { restored, saved } = await restore(Number(argument));
    console.log(
      `Restored snapshot ${restored.number} (${restored.message}); the state before is snapshot ${saved.number}.`,
    );
  } else {
    console.log('Usage: node core/snapshot.mjs save "<message>" | list | restore <number>');
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith("snapshot.mjs")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
