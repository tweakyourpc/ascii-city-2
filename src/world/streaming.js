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
    onUpdate = () => {},
    onStatus = () => {},
  }) {
    this.fetchChunk = fetchChunk;
    this.spanDeg = spanDeg;
    this.maxChunks = Math.max(3, maxChunks | 0);
    this.maxConcurrent = Math.max(1, maxConcurrent | 0);
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.loaded = new Map();
    this.inFlight = new Map();
    this.queue = [];
    this.elements = new Map();
    this.initialBBox = initialBBox;
    this.originLat = (initialBBox[0] + initialBBox[2]) / 2;
    this.originLon = (initialBBox[1] + initialBBox[3]) / 2;
    this.lonStep = spanDeg / Math.max(0.2, Math.cos(this.originLat * Math.PI / 180));
    this.lastCenter = null;
    this.disposed = false;
    this.loaded.set('seed', { key: 'seed', bbox: initialBBox, elements: initialElements });
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
        if (dx === 0 && dy === 0) continue;
        keys.push({ key: `${ix + dx},${iy + dy}`, distance: dx * dx + dy * dy });
      }
    }
    return keys.sort((a, b) => a.distance - b.distance).map((entry) => entry.key);
  }

  update(lat, lon) {
    if (this.disposed || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const center = this.tileKey(lat, lon);
    if (center === this.lastCenter && this.queue.length === 0) return;
    this.lastCenter = center;
    for (const key of this._wanted(center)) {
      if (this.loaded.has(key) || this.inFlight.has(key) || this.queue.includes(key)) continue;
      this.queue.push(key);
    }
    this._pump();
    this._prune(center);
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
          if (this.disposed) return;
          this.loaded.set(key, { key, bbox, elements: elements || [] });
          this._mergeElements(elements);
          if (this.lastCenter) this._prune(this.lastCenter);
          this.onUpdate(this.snapshot());
        })
        .catch((err) => {
          if (!this.disposed && err?.name !== 'AbortError') {
            this.onStatus(`Map region ${key} unavailable; keeping current view`);
          }
        })
        .finally(() => {
          this.inFlight.delete(key);
          this._pump();
        });
    }
  }

  _prune(centerKey) {
    const { ix, iy } = this._parseKey(centerKey);
    const candidates = [...this.loaded.values()]
      .filter((chunk) => chunk.key !== 'seed')
      .map((chunk) => {
        const p = this._parseKey(chunk.key);
        return { chunk, distance: (p.ix - ix) ** 2 + (p.iy - iy) ** 2 };
      })
      .sort((a, b) => a.distance - b.distance);
    while (this.loaded.size > this.maxChunks && candidates.length) {
      this.loaded.delete(candidates.pop().chunk.key);
      this._rebuildElements();
    }
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
    };
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.queue.length = 0;
  }
}
