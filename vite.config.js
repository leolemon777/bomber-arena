import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { devBridge, publicFileEvents } from "./core/dev.js";

// The multiplayer kit, when this folder has it (core/mp/, which the web games Skill installs for
// a game several people play): its plugin hosts a local room for the rules in src/logic.js, so
// ?room=dev in two pages is one room. A folder without the kit is a game for one player, and
// nothing of the kit is loaded. Installing the kit touches this file, which restarts the server.
const kit = new URL("./core/mp/dev-plugin.mjs", import.meta.url);
const multiplayer = existsSync(fileURLToPath(kit))
  ? (await import(kit.href)).multiplayerDev()
  : undefined;

// One port per folder, so the game keeps its address, and the saves its page keeps, each time its
// server starts. PORT, when set, wins. A taken port stops the start instead of moving on: a second
// server for the same folder says so at once rather than running beside the first.
const port =
  Number(process.env.PORT) ||
  41000 +
    (parseInt(createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8), 16) % 8000);

// A build's addresses are relative, so the built game runs from any folder of a site.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  // The game draws with WebGPURenderer (WebGL2 where there is no WebGPU): `three` is its build,
  // for the game and for every addon, so all of them share one set of classes and node materials.
  resolve: { alias: [{ find: /^three$/, replacement: "three/webgpu" }] },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    // The app shows a page's errors itself; Vite's overlay would cover the game.
    hmr: { overlay: false },
    // Version snapshots (core/snapshot.mjs) hold copies of index.html: saving one must not reload.
    watch: { ignored: ["**/.versions/**"] },
    // The tools page reads a detailed model where it is kept, in the Agent's work folder, as
    // /@fs/<absolute path>; the game itself loads only what is in its own folder.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), process.env.MESHY_WORK].filter(Boolean),
    },
  },
  plugins: [publicFileEvents(), devBridge(), multiplayer].filter(Boolean),
}));
