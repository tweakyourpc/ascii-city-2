/**
 * Bounded OSM region streamer.
 *
 * The existing OsmWorld remains the renderer's canonical world. This manager
 * fetches neighboring geographic tiles, deduplicates their elements, and
 * emits a merged snapshot for a controlled world rebuild. Rebuilding is
 * deliberate: it preserves the existing typed-array hot path while making the
 * geographic boundary advance ahead of the camera.
 */
export class OSMStream {
  constructor({
    fetchChunk,
    initialBBox,
    initialElements = [],
    spanDeg = 0.0055,
    maxChunks = 9,
    maxConcurrent = 2,
    rebuildDebounceMs = 250,
    onUpdate = () => {},
    onStatus = () => {},
    schedule = setTimeout,
    cancel = clearTimeout,
  }) {
    this.fetchChunk = fetchChunk;
    this.spanDeg = spanDeg;
    this.maxChunks = Math.max(3, maxChunks | 0);
    this.maxConcurrent = Math.max(1, maxConcurrent | 0);
    this.rebuildDebounceMs = Math.max(0, rebuildDebounceMs | 0);
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.schedule = schedule;
    this.cancel = cancel;
    this.loaded = new Map();
    this.inFlight = new Map();
    this.queue = [];
    this.elements = new Map();
    this.initialBBox = initialBBox;
    this.originLat = (initialBBox[0] + initialBBox[2]) / 2;
    this.originLon = (initialBBox[1] + initialBBox[3]) / 2;
    this.lonStep = spanDeg / Math.max(0.2, Math.cos(this.originLat * Math.PI / 180));
    this.lastCenter = null;
    this.holdSeed = true;
    this.wanted = new Set();
    this.revision = 0;
    this.updateTimer = null;
    this.disposed = false;
    // The initial extract is the centre tile, and it keeps an ordinary tile
    // key so it can leave the cache once the camera travels away: pinning a
    // seed forever makes the rebuilt world's grid grow without bound.
    //
    // But it is also usually much LARGER than a streamed tile — an airfield
    // box is several kilometres of runway against 0.6 km tiles — so dropping
    // it the moment the camera crosses one tile boundary shrinks the world
    // below what was originally asked for, and the far half of the runway you
    // are flying down disappears. It is therefore held while the camera is
    // still inside it, which is bounded because the seed is a fixed size.
    this.seedKey = '0,0';
    this.loaded.set('0,0', { key: '0,0', bbox: initialBBox, elements: initialElements });
    this._mergeElements(initialElements);
  }

  tileKey(lat, lon) {
    const ix = Math.floor((lon - this.originLon) / this.lonStep + 0.5);
    const iy = Math.floor((lat - this.originLat) / this.spanDeg + 0.5);
    return `${ix},${iy}`;
  }

  tileBox(ix, iy) {
    const centerLat = this.originLat + iy * this.spanDeg;
    const centerLon = this.originLon + ix * this.lonStep;
    return [
      centerLat - this.spanDeg / 2,
      centerLon - this.lonStep / 2,
      centerLat + this.spanDeg / 2,
      centerLon + this.lonStep / 2,
    ];
  }

  _parseKey(key) {
    const [ix, iy] = key.split(',').map(Number);
    return { ix, iy };
  }

  _mergeElements(elements) {
    for (const el of elements || []) {
      if (!el || el.id === undefined || !el.type) continue;
      this.elements.set(`${el.type}/${el.id}`, el);
    }
  }

  _rebuildElements() {
    this.elements.clear();
    for (const chunk of this.loaded.values()) this._mergeElements(chunk.elements);
  }

  _wanted(centerKey) {
    const { ix, iy } = this._parseKey(centerKey);
    const keys = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        keys.push({ key: `${ix + dx},${iy + dy}`, distance: dx * dx + dy * dy });
      }
    }
    return keys.sort((a, b) => a.distance - b.distance).map((entry) => entry.key);
  }

  update(lat, lon) {
    if (this.disposed || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const center = this.tileKey(lat, lon);
    const hold = this._insideSeed(lat, lon);
    if (center === this.lastCenter && hold === this.holdSeed
        && this.queue.length === 0) return;
    this.lastCenter = center;
    this.holdSeed = hold;
    const wanted = new Set(this._wanted(center));
    this.wanted = wanted;

    // A fast move or shared-link teleport invalidates queued/fetching regions.
    // Abort them even if the fetcher ignores the signal; the identity check in
    // _pump prevents a late result from re-entering the active cache.
    this.queue = this.queue.filter((key) => wanted.has(key));
    for (const [key, controller] of this.inFlight) {
      if (wanted.has(key)) continue;
      controller.abort();
      this.inFlight.delete(key);
    }

    this._prune(center);
    for (const key of wanted) {
      if (this.loaded.has(key) || this.inFlight.has(key) || this.queue.includes(key)) continue;
      this.queue.push(key);
    }
    this._pump();
  }

  _pump() {
    while (!this.disposed && this.inFlight.size < this.maxConcurrent && this.queue.length) {
      const key = this.queue.shift();
      const { ix, iy } = this._parseKey(key);
      const bbox = this.tileBox(ix, iy);
      const controller = new AbortController();
      this.inFlight.set(key, controller);
      this.onStatus(`Loading map region ${key}`);
      Promise.resolve(this.fetchChunk(bbox, { signal: controller.signal }))
        .then((elements) => {
          if (this.disposed || controller.signal.aborted ||
              this.inFlight.get(key) !== controller || !this.wanted.has(key)) return;
          this.loaded.set(key, { key, bbox, elements: elements || [] });
          if (this.lastCenter) this._prune(this.lastCenter);
          this._rebuildElements();
          this._scheduleUpdate();
        })
        .catch((err) => {
          if (!this.disposed && err?.name !== 'AbortError') {
            this.onStatus(`Map region ${key} unavailable; keeping current view`);
          }
        })
        .finally(() => {
          if (this.inFlight.get(key) === controller) this.inFlight.delete(key);
          this._pump();
        });
    }
  }

  /** Is the camera still standing inside the original extract? */
  _insideSeed(lat, lon) {
    const [s, w, n, e] = this.initialBBox;
    return lat >= s && lat <= n && lon >= w && lon <= e;
  }

  _prune(centerKey) {
    const { ix, iy } = this._parseKey(centerKey);
    // Remove everything outside the newest 3x3 window first. The distance
    // fallback enforces maxChunks if a caller deliberately configures less.
    for (const key of this.loaded.keys()) {
      if (key === this.seedKey && this.holdSeed) continue;
      if (!this.wanted.has(key)) this.loaded.delete(key);
    }
    const candidates = [...this.loaded.values()]
      .map((chunk) => {
        const p = this._parseKey(chunk.key);
        return { chunk, distance: (p.ix - ix) ** 2 + (p.iy - iy) ** 2 };
      })
      .filter((c) => !(this.holdSeed && c.chunk.key === this.seedKey))
      .sort((a, b) => a.distance - b.distance);
    const budget = this.maxChunks + (this.holdSeed ? 1 : 0);
    while (this.loaded.size > budget && candidates.length) {
      this.loaded.delete(candidates.pop().chunk.key);
    }
    this._rebuildElements();
  }

  _scheduleUpdate() {
    if (this.updateTimer !== null) this.cancel(this.updateTimer);
    this.updateTimer = this.schedule(() => {
      this.updateTimer = null;
      if (this.disposed || this.loaded.size === 0) return;
      this.revision++;
      this.onUpdate(this.snapshot());
    }, this.rebuildDebounceMs);
  }

  snapshot() {
    const chunks = [...this.loaded.values()];
    const bbox = [
      Math.min(...chunks.map((chunk) => chunk.bbox[0])),
      Math.min(...chunks.map((chunk) => chunk.bbox[1])),
      Math.max(...chunks.map((chunk) => chunk.bbox[2])),
      Math.max(...chunks.map((chunk) => chunk.bbox[3])),
    ];
    return {
      bbox,
      elements: [...this.elements.values()],
      loaded: chunks.map((chunk) => chunk.key),
      centerKey: this.lastCenter,
      revision: this.revision,
    };
  }

  dispose() {
    this.disposed = true;
    if (this.updateTimer !== null) this.cancel(this.updateTimer);
    this.updateTimer = null;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.queue.length = 0;
  }
}
