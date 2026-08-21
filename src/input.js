/**
 * Keyboard, mouse and touch, reduced to a plain state object the update loop
 * can poll. Owns no camera state.
 */
export class Input {
  constructor(canvas) {
    this.keys = Object.create(null);
    this.dragging = false;
    this.dx = 0;          // accumulated look delta, consumed by the update loop
    this.dy = 0;
    this.hourShift = 0;   // accumulated [ and ] presses
    this.taps = Object.create(null);   // discrete presses, for toggles
    this.click = null;    // {x, y} in CSS px, consumed by takeClick()
    this.hover = null;    // {x, y} in CSS px, last pointer position

    this._lastX = 0;
    this._lastY = 0;
    this._downX = 0;
    this._downY = 0;
    this._downT = 0;
    this._moved = 0;
    this._bind(canvas);
  }

  _bind(canvas) {
    window.addEventListener('keydown', (e) => {
      // Let the browser have text input in the HUD.
      if (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (!this.keys[k]) this.taps[k] = (this.taps[k] || 0) + 1;   // ignore autorepeat
      this.keys[k] = true;
      if (k === '[') this.hourShift -= 1;
      if (k === ']') this.hourShift += 1;
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => {
      this.keys = Object.create(null);
      this.dragging = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._downX = e.clientX;
      this._downY = e.clientY;
      this._downT = performance.now();
      this._moved = 0;
    });
    window.addEventListener('mousemove', (e) => {
      // Tracked even when not dragging, so the panel can offer a pointer
      // cursor over the rows that are actually links.
      this.hover = { x: e.clientX, y: e.clientY };
      if (!this.dragging) return;
      // Accumulated travel, not net displacement: a circular drag that returns
      // to where it started must not count as a click.
      this._moved += Math.abs(e.clientX - this._lastX)
                   + Math.abs(e.clientY - this._lastY);
      this.dx += e.clientX - this._lastX;
      this.dy += e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    window.addEventListener('mouseup', (e) => {
      if (this.dragging && this._moved < 5 &&
          performance.now() - this._downT < 400) {
        this.click = { x: e.clientX, y: e.clientY };
      }
      this.dragging = false;
    });

    canvas.addEventListener('touchstart', (e) => {
      this.dragging = true;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
      this._downT = performance.now();
      this._moved = 0;
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (!this.dragging) return;
      this._moved += Math.abs(e.touches[0].clientX - this._lastX)
                   + Math.abs(e.touches[0].clientY - this._lastY);
      this.dx += (e.touches[0].clientX - this._lastX) * 1.5;
      this.dy += (e.touches[0].clientY - this._lastY) * 1.5;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchend', (e) => {
      // touches is empty by now; the released finger is in changedTouches.
      const t = e.changedTouches && e.changedTouches[0];
      if (this.dragging && t && this._moved < 12 &&
          performance.now() - this._downT < 500) {
        this.click = { x: t.clientX, y: t.clientY };
      }
      this.dragging = false;
    });
  }

  /** Read and clear the accumulated look delta. */
  takeLook() {
    const d = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  /** Consume discrete presses of a key since the last call. */
  takeTaps(k) {
    const n = this.taps[k] || 0;
    if (n) this.taps[k] = 0;
    return n;
  }

  takeClick() {
    const c = this.click;
    this.click = null;
    return c;
  }

  takeHourShift() {
    const h = this.hourShift;
    this.hourShift = 0;
    return h;
  }

  down(k) {
    return !!this.keys[k];
  }
}
