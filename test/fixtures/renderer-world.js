import { T, hash } from '../../src/world/source.js';

/** Compact deterministic skyline used only by renderer regression tests. */
export function rendererWorld() {
  const width = 40;
  const height = 44;
  const n = width * height;
  const world = {
    width, height, size: 0, maxHeight: 18, voidSlot: n,
    h: new Float32Array(n + 1),
    type: new Uint8Array(n + 1).fill(T.PLAZA),
    rnd: new Float32Array(n + 1),
    lamp: new Float32Array(n + 1),
    pal: new Uint8Array(n + 1),
    flags: new Uint8Array(n + 1),
    sample(x, y) {
      x = Math.floor(x); y = Math.floor(y);
      return x < 0 || x >= width || y < 0 || y >= height
        ? this.voidSlot : y * width + x;
    },
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) world.rnd[y * width + x] = hash(x, y, 42);
  }
  world.type[world.voidSlot] = T.VOID;

  const building = (x0, y0, x1, y1, h, pal) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        world.h[i] = h;
        world.type[i] = h > 8 ? T.TOWER : T.HOUSE;
        world.pal[i] = pal;
      }
    }
  };

  // A low foreground building with taller offset towers behind it exercises
  // the renderer's vertical coverage rather than a first-hit-only ray.
  building(16, 20, 23, 24, 6, 1);
  building(7, 29, 13, 36, 12, 3);
  building(25, 27, 32, 37, 18, 5);
  building(17, 34, 22, 40, 10, 6);

  // A cross street keeps ground texture and depth transitions in the fixture.
  for (let y = 0; y < height; y++) {
    for (let x = 19; x <= 21; x++) {
      const i = y * width + x;
      if (world.h[i] === 0) world.type[i] = T.ROAD;
    }
  }
  for (let y = 15; y <= 17; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (world.h[i] === 0) world.type[i] = T.ROAD;
    }
  }

  return world;
}
