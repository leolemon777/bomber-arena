// Where the game's files are, wherever its page is served from. While it is built the page is at
// the dev server's root; a packaged game runs from any folder of a site, so nothing here asks for
// a file from the root.
//
//   fetch(assetUrl("data/levels.json"))        a file under public/, relative to the page
//   localStorage.getItem(storageKey("save"))   a storage key no other game on the site uses

/** The address of a file under public/, relative to the page; a leading slash is ignored. */
export const assetUrl = (path) => String(path).replace(/^\/+/, "");

/**
 * A value the page of a packaged game carries (<script type="application/json" id="…">), so it
 * is there before any request; undefined while the game is built, when the files are read.
 */
export function carried(id) {
  const element = globalThis.document?.getElementById(id);
  if (!element) {
    return undefined;
  }
  try {
    return JSON.parse(element.textContent);
  } catch {
    return undefined;
  }
}

/** A localStorage key of this game's own: games served from one site share its storage. */
export const storageKey = (name) =>
  `${globalThis.location ? new URL(globalThis.document?.baseURI ?? globalThis.location.href).pathname : "/"}:${name}`;
