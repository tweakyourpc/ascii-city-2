import { col2str } from '../screen.js';
import { normAngle } from '../camera.js';
import { altAz, STARS, NAMED_STARS } from '../astro.js';
import { planets, moon, moonGlyph, daysSinceEpoch } from '../planets.js';
import { FOV } from '../config.js';

/**
 * Project a horizontal coordinate (azimuth, altitude in degrees) to a grid cell.
 * Objects at infinity, so nothing here depends on the camera's height.
 */
export function project(screen, cam, azDeg, altDeg) {
  const theta = (90 - azDeg) * Math.PI / 180;
  const da = normAngle(theta - cam.angle);
  if (Math.abs(da) > FOV * 0.7) return null;

  // Negative because a positive angular offset is counter-clockwise, which is
  // to the LEFT, which is a smaller column. See camera.buildRays.
  const x = Math.round(screen.cols / 2 - Math.tan(da) * screen.proj);
  const y = Math.round(cam.hz - Math.tan(Math.min(85, altDeg) * Math.PI / 180) * screen.vscale);
  if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) return null;
  return { x, y };
}

/**
 * Paint the sky gradient onto the canvas directly, up to each column's sky
 * limit, then overlay stars and the sun as glyphs.
 */
/**
 * Draw one sky object as a glyph, recording it for picking.
 * Returns true if it was actually on screen and unobstructed.
 */
function place(screen, cam, marks, o, alt, az, glyph, colour) {
  const p = project(screen, cam, az, alt);
  if (!p || p.y >= screen.skyEnd[p.x]) return false;
  screen.set(p.x, p.y, glyph, colour);
  if (marks) marks.add(p.x, p.y, { ...o, alt, az });
  return true;
}

export function drawSky(screen, cam, L, site, jd, sun, sunAlt, dayK, when, marks) {
  const { ctx, cols, cw, ch, skyEnd } = screen;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, screen.width, screen.height);

  const gh = Math.max(2, cam.hz * ch);
  const grad = ctx.createLinearGradient(0, 0, 0, gh);
  grad.addColorStop(0, col2str(...L.skyTop));
  grad.addColorStop(1, col2str(...L.skyBottom));
  ctx.fillStyle = grad;

  // One rect per run of columns sharing a sky height, rather than one per column.
  let run = 0;
  for (let x = 0; x <= cols; x++) {
    if (x === cols || skyEnd[x] !== skyEnd[run]) {
      if (skyEnd[run] > 0) ctx.fillRect(run * cw, 0, (x - run) * cw + 1, skyEnd[run] * ch);
      run = x;
    }
  }

  // Columns the raycaster left gaps in, such as a canopy above the horizon,
  // get sky painted into each uncovered run rather than one rect up to a
  // watermark.
  // The gradient is in user space, so any sub-rect samples the same ramp.
  if (screen.hasHoles) {
    const limit = Math.max(0, Math.ceil(cam.hz));
    const words = screen.covWords;
    for (let x = 0; x < cols; x++) {
      if (!screen.hasHoles[x]) continue;
      const base = x * words;
      let y = 0;
      while (y < limit) {
        if ((screen.holeMask[base + (y >> 5)] >>> (y & 31)) & 1) { y++; continue; }
        const start = y;
        while (y < limit &&
               !((screen.holeMask[base + (y >> 5)] >>> (y & 31)) & 1)) y++;
        ctx.fillRect(x * cw, start * ch, cw + 1, (y - start) * ch);
      }
    }
  }

  if (marks) marks.reset();

  if (dayK < 0.62) {
    const starDim = 1 - dayK / 0.62;
    for (let i = 0; i < STARS.length; i++) {
      const st = STARS[i];
      const q = altAz(st[0], st[1], jd, site.lat, site.lon);
      if (q.alt <= 1) continue;
      const p = project(screen, cam, q.az, q.alt);
      if (!p || p.y >= skyEnd[p.x]) continue;
      const m = st[2];
      const bright = Math.max(0, Math.min(1, (4.7 - m) / 4.6)) * starDim;
      if (bright < 0.06) continue;
      screen.set(p.x, p.y, m < 0.6 ? '*' : m < 2 ? '+' : '.',
                 col2str(250 * bright, 220 * bright, 255 * bright));

      // Only the catalogued stars are nameable. The procedural filler is
      // anonymous by construction and must not claim to be anything.
      if (marks && i < NAMED_STARS.length) {
        const info = NAMED_STARS[i];
        marks.add(p.x, p.y, {
          kind: 'star', name: info.name,
          detail: `${info.bayer} · ${info.con}`,
          mag: m, alt: q.alt, az: q.az,
        });
      }
    }
  }

  /* ---- Moon and planets ---- */
  if (when) {
    const d = daysSinceEpoch(when);

    // Planets are visible at twilight before the faint stars are.
    if (dayK < 0.80) {
      const dim = Math.max(0, Math.min(1, (0.80 - dayK) / 0.5));
      for (const pl of planets(d)) {
        const q = altAz(pl.ra, pl.dec, jd, site.lat, site.lon);
        if (q.alt <= 1) continue;
        const b = Math.max(0.25, Math.min(1, (2.2 - pl.mag) / 4)) * dim;
        const glyph = pl.mag < -2 ? '@' : pl.mag < 0.5 ? '*' : '+';
        place(screen, cam, marks, {
          kind: 'planet', name: pl.name,
          detail: `${pl.dist.toFixed(2)} AU · elongation ${pl.elongation.toFixed(0)}°`,
          mag: pl.mag,
        }, q.alt, q.az, glyph,
        col2str(pl.colour[0] * b, pl.colour[1] * b, pl.colour[2] * b));
      }
    }

    const mo = moon(d);
    const mq = altAz(mo.ra, mo.dec, jd, site.lat, site.lon);
    if (mq.alt > 0.5) {
      // The Moon is visible in daylight too, just washed out.
      const b = Math.max(0.35, 1 - dayK * 0.45) * (0.35 + 0.65 * mo.illuminated);
      place(screen, cam, marks, {
        kind: 'moon', name: 'The Moon',
        detail: `${mo.phaseName} · ${Math.round(mo.illuminated * 100)}% lit · `
              + `${Math.round(mo.distKm).toLocaleString('en-US')} km`,
        mag: mo.mag,
      }, mq.alt, mq.az, moonGlyph(mo.illuminated),
      col2str(mo.colour[0] * b, mo.colour[1] * b, mo.colour[2] * b));
    }
  }

  if (sunAlt > -2) {
    const p = project(screen, cam, sun.az, sunAlt);
    if (p && marks) {
      marks.add(p.x, p.y, {
        kind: 'sun', name: 'The Sun',
        detail: `altitude ${sunAlt.toFixed(1)}°`, mag: -26.7,
      });
    }
    if (p) {
      const warm = sunAlt < 8;
      const sc = warm ? col2str(255, 168, 90) : col2str(255, 244, 200);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const sx = p.x + ox;
          const sy = p.y + oy;
          if (sx < 0 || sx >= cols || sy < 0 || sy >= skyEnd[sx]) continue;
          if (Math.abs(ox) + Math.abs(oy) * 2 > 3) continue;
          screen.set(sx, sy, '@', sc);
        }
      }
    }
  }
}
