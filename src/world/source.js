/**
 * The world interface the renderer talks to.
 *
 * `cellInfo()` in the original engine was called roughly 12k times per frame by
 * the floor cast alone, and avoided allocating by caching one object per cell in
 * a Map. Introducing a module boundary must not regress that, so no objects
 * cross this boundary at all: `sample(cx, cy)` returns an integer *slot*, and
 * callers read parallel typed arrays.
 *
 *     const s = world.sample(mx, my);
 *     const h = world.h[s];
 *
 * SLOT VALIDITY: a slot is valid until the next `sample()` that lands in a
 * different chunk. Read the fields you need immediately; never hold a slot
 * across a loop iteration that samples again.
 *
 * Storage is 32x32 chunks in a pooled set of typed arrays, with a one-entry
 * last-chunk memo. That memo hits ~99% of the time in both the row-major floor
 * cast and the spatially coherent DDA.
 */

/** Cell types. Integers, so the renderer's inner loop compares numbers. */
export const T = {
  VOID: 0,
  ROAD: 1,
  PATH: 2,
  SIDEWALK: 3,
  PLAZA: 4,
  YARD: 5,
  FIELD: 6,
  FARM: 7,
  WATER: 8,
  TREE: 9,
  FOREST: 10,
  HOUSE: 11,
  TOWER: 12,
};

/** Bits in the per-cell `flags` array. */
export const F = {
  STRIPE: 1,     // road centre line
  BEACON: 2,     // aircraft warning light on the roof
};

export const CHUNK = 32;
export const CHUNK_CELLS = CHUNK * CHUNK;
const CHUNK_MASK = CHUNK - 1;
const CHUNK_SHIFT = 5;

export function hash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function wrap(v, m) {
  return ((v % m) + m) % m;
}

/**
 * Chunked struct-of-arrays store. Subclasses implement `fillChunk`, which
 * writes CHUNK_CELLS cells starting at `base`.
 */
export class ChunkedWorld {
  /** @param {{ maxChunks?: number, size?: number }} opts */
  constructor({ maxChunks = 4096, size = 0 } = {}) {
    this.size = size;               // wrap period in cells, 0 = unbounded
    this.maxHeight = 0;             // global tallest, drives the DDA early-out
    this.maxChunks = maxChunks;

    this._cap = 0;
    this._used = 0;
    this._index = new Map();        // chunk key -> chunk ordinal
    this._memoKey = -1;             // last-chunk memo
    this._memoBase = 0;

    this._grow(64);
  }

  _grow(chunks) {
    const cells = chunks * CHUNK_CELLS;
    const h = new Float32Array(cells);
    const type = new Uint8Array(cells);
    const rnd = new Float32Array(cells);
    const lamp = new Float32Array(cells);
    const pal = new Uint8Array(cells);
    const flags = new Uint8Array(cells);
    if (this._cap > 0) {
      h.set(this.h); type.set(this.type); rnd.set(this.rnd);
      lamp.set(this.lamp); pal.set(this.pal); flags.set(this.flags);
    }
    this.h = h; this.type = type; this.rnd = rnd;
    this.lamp = lamp; this.pal = pal; this.flags = flags;
    this._cap = chunks;
  }

  /** Drop every chunk. Used when the store fills up, or on world reload. */
  reset() {
    this._index.clear();
    this._used = 0;
    this._memoKey = -1;
    this._memoBase = 0;
  }

  /**
   * Map a world cell to a slot, generating its chunk on first touch.
   * @returns {number} slot index into h/type/rnd/lamp/pal/flags
   */
  sample(cx, cy) {
    let ax = Math.floor(cx);
    let ay = Math.floor(cy);
    if (this.size > 0) {
      ax = wrap(ax, this.size);
      ay = wrap(ay, this.size);
    }

    const ccx = ax >> CHUNK_SHIFT;
    const ccy = ay >> CHUNK_SHIFT;
    const key = ccy * 0x40000 + ccx;

    let base;
    if (key === this._memoKey) {
      base = this._memoBase;
    } else {
      const found = this._index.get(key);
      base = found !== undefined ? found : this._makeChunk(ccx, ccy, key);
      this._memoKey = key;
      this._memoBase = base;
    }

    return base + ((ay & CHUNK_MASK) << CHUNK_SHIFT) + (ax & CHUNK_MASK);
  }

  _makeChunk(ccx, ccy, key) {
    if (this._used >= this.maxChunks) {
      // Wholesale eviction. Cheaper than an LRU and rare in practice, because
      // the fog cutoff bounds how much of the world is reachable per frame.
      this.reset();
    }
    if (this._used >= this._cap) this._grow(this._cap * 2);

    const base = this._used * CHUNK_CELLS;
    this._used++;
    this._index.set(key, base);
    this.fillChunk(ccx * CHUNK, ccy * CHUNK, base);
    return base;
  }

  /**
   * Populate one chunk. Subclass responsibility.
   * @param {number} ox world cell x of the chunk origin
   * @param {number} oy world cell y of the chunk origin
   * @param {number} base slot index of cell (ox, oy)
   */
  // eslint-disable-next-line no-unused-vars
  fillChunk(ox, oy, base) {
    throw new Error('fillChunk not implemented');
  }

  /** Resolves when the world is ready to render. */
  ready() {
    return Promise.resolve(this);
  }

  /** Height of the tallest thing near (cx, cy). Default: the global maximum. */
  maxHeightAt() {
    return this.maxHeight;
  }

  dispose() {
    this.reset();
  }
}
