// Phaser writes a few small images into its own code as data: addresses: the blank, missing and
// white textures every game starts with, and a test of the browser's blend modes. A site whose
// content security policy takes images only from itself and from blob: addresses refuses them
// (Meshy 3D Games does), and Phaser then stops before its first frame. This file hands an image
// written as a data: address to the browser as a blob: address holding the same bytes. The
// runtime imports it before Phaser, so it is in place when Phaser asks for its first image.
const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");

/** The bytes of a data: address under a blob: address, or undefined when it cannot be read. */
function asBlobAddress(address) {
  const comma = address.indexOf(",");
  const [type, ...flags] = address.slice("data:".length, comma).split(";");
  const body = address.slice(comma + 1);
  try {
    const bytes = flags.includes("base64")
      ? Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return URL.createObjectURL(new Blob([bytes], { type }));
  } catch {
    return undefined;
  }
}

Object.defineProperty(HTMLImageElement.prototype, "src", {
  ...src,
  set(value) {
    const address =
      typeof value === "string" && value.startsWith("data:") ? asBlobAddress(value) : undefined;
    if (address) {
      // The image holds its pixels once it has loaded; the address is no longer needed.
      const release = () => URL.revokeObjectURL(address);
      this.addEventListener("load", release, { once: true });
      this.addEventListener("error", release, { once: true });
    }
    src.set.call(this, address ?? value);
  },
});
