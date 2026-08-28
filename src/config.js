/**
 * Every tunable in one place. Values that were magic numbers scattered through
 * the original single-file engine live here with a note on what they control.
 */

/* ------------------------------- display ------------------------------- */

/**
 * 0 = glyph (one character per cell), 1 = half-block (double vertical
 * resolution, solid colour). See MODE in screen.js. Toggled at runtime with B.
 */
// Start in the hybrid view; B cycles through classic glyphs and BLOCK mode.
export const RENDER_MODE = 2;

export const FONT_PX = 14;
export const FONT_STACK = 'ui-monospace, Menlo, Consolas, monospace';
export const LINE_RATIO = 1.05;        // cell height as a multiple of font size
export const FOV = 1.15;               // radians, horizontal
export const HORIZON_FRAC = 0.52;      // horizon as a fraction of screen rows

/* ------------------------------- distance ------------------------------ */

export const MAXD = 175;               // DDA draw distance, cells
export const FOG_K = 0.0125;           // exp(-d * FOG_K)
export const FOG_FULL = 320;           // past here everything is pure haze;
                                       // fogOf(320) is about 0.018

/* -------------------------------- scale --------------------------------
 * FLOOR_H is primary: it is the facade texture's window-row pitch, inherited
 * from the original engine. The metric scale is derived from it, so that one
 * real storey occupies exactly one rendered floor and OSM `building:levels`
 * lines up with the window rows for free.
 *
 * Calibration constants. Check them on screen after changing either.
 */

export const FLOOR_H = 1.35;                                   // cells per storey
export const STOREY_METERS = 3.2;
export const METERS_PER_CELL = STOREY_METERS / FLOOR_H;        // about 2.37 m

/* -------------------------------- camera -------------------------------- */

export const EYE_HEIGHT = 1.65;        // standing eye height, cells
export const MIN_CAM_Z = 0.05;         // below this the floor cast degenerates
export const MAX_CAM_Z = 400;          // soft ceiling
export const Z_ACCEL = 26;             // cells/s^2 on Q/E
export const Z_DAMP = 0.02;            // velocity retained per second
export const WALK_SPEED = 5.6;
export const RUN_MULT = 4.0;
/**
 * Travel speed scales with altitude, the way every map and flight view does:
 * you move at a rate proportional to how much you can see. At eye level this
 * is a walk; at 200 m it crosses a city in seconds, without making street
 * level uncontrollable.
 */
export const SPEED_PER_CELL_UP = 0.035;
// Capped so the fastest case still crosses a loaded extract in a few seconds
// rather than in one. Uncapped, altitude alone reached Mach 2.
export const MAX_SPEED_MULT = 6;
export const BODY_R = 0.28;            // collision half-width, cells
export const MOVE_CLEAR = 0.35;        // vertical clearance needed to fly over
export const WADE_Z = 2.0;             // above this you fly over water

/* ------------------------------- aircraft ------------------------------- */

/**
 * Live ADS-B aircraft, another truthful layer of the real world (like OSM
 * geography and the astronomical sky). All of it is optional and degrades to
 * "no aircraft" on any failure.
 *
 * No keyless ADS-B provider sends browser-permissive CORS headers, so requests
 * require an explicitly configured, deployment-owned Worker.
 */
export const AIR_ENABLED = true;        // master switch (also toggled with T)
export const AIR_REFRESH_MS = 20000;    // poll cadence; ADS-B needs no faster
export const AIR_RADIUS_KM = 30;       // query radius around the camera
export const AIR_ALT_MIN_M = 30;        // ignore surface/taxiing traffic
export const AIR_GLYPH = '✈';          // aircraft mark
/* ------------------------------- weather -------------------------------- */

/**
 * Live weather, another truthful layer of the real world (like OSM geography,
 * the astronomical sky, and live aircraft). Open-Meteo is keyless and sends
 * browser-permissive CORS headers, so unlike ADS-B it needs no proxy and works
 * straight from the browser. Everything is strictly additive and degrades to
 * "no weather" on any failure, so a missing or offline source never spoils the
 * city. Weather only shows while the clock controller is explicitly LIVE.
 */
export const WX_ENABLED = true;          // master switch (also toggled with Y)
export const WX_REFRESH_MS = 600000;     // 10 min; weather is slow to change
export const WX_RADIUS_KM = 5;           // query radius around the camera
export const WX_GLYPH = '*';             // precipitation mark (overridden by kind)

/* ------------------------------ earthquakes ----------------------------- */

/**
 * Live earthquakes, another truthful layer of the real world (like OSM
 * geography, the astronomical sky, live aircraft, and live weather). USGS is
 * keyless and sends browser-permissive CORS headers, so unlike ADS-B it needs
 * no proxy and works straight from the browser. Everything is strictly additive
 * and degrades to "no quakes" on any failure. Quakes only show while the clock
 * controller is explicitly LIVE.
 */
export const QUAKE_ENABLED = true;        // master switch (also toggled with K)
export const QUAKE_REFRESH_MS = 60000;   // 1 min; the feed is updated ~every min
export const QUAKE_RADIUS_KM = 300;      // keep only quakes within this of the city
export const QUAKE_MIN_MAG = 2.5;        // ignore the constant micro-tremors

/* -------------------------------- flock -------------------------------- */

/**
 * Live ALPR/"flock" camera map, another truthful layer of the real world (like
 * OSM geography, the sky, aircraft, weather, and quakes). DeFlock publishes the
 * global license-plate-reader network as keyless 20-degree vector tiles on a
 * CDN, but the CDN sends no CORS headers, so requests require an explicitly
 * configured, deployment-owned Worker (exactly like the ADS-B aircraft feed).
 * Everything is strictly additive and degrades to "no cameras" on any failure.
 */
export const FLOCK_ENABLED = true;        // master switch (also toggled with F)
export const FLOCK_REFRESH_MS = 3600000; // 1 h; the dataset is updated daily
export const FLOCK_RADIUS_KM = 30;        // keep only cameras within this of the city
export const FLOCK_TILE_DEG = 20;         // DeFlock region tile size, degrees

/* ------------------------------ procedural ------------------------------ */

export const WORLD = 2048;             // wrap period, cells
export const BLOCK = 14;               // city block pitch, cells
export const SEED = 1337;

/* ------------------------------- palettes ------------------------------- */

export const GLYPH_RAMP = ' .:-=+*#%@';
// Window light colours, one per facade palette entry. Warm interior glows
// dominate; a couple of cooler tints add variety so not every lit window is
// the same yellow. Length must match FACADE so palIdx indexes both.
export const LIT = [
  [255, 198, 120], [130, 226, 255], [255, 130, 216], [176, 255, 190],
  [255, 188, 110], [150, 220, 255], [255, 150, 200], [200, 255, 180],
];
// Building facades and roofs. A spread of warm stone tones — beige, sand,
// cream, taupe, warm grey, pale stone — so the city reads as varied masonry
// rather than one flat colour. Every entry keeps R > B so towers stay
// chromatically distinct from the cool blue-grey roads and pavement. The count
// is a power of two so world code can pick an index with a cheap bitmask.
export const FACADE = [
  [150, 124, 96],   // beige
  [134, 116, 92],   // sand
  [168, 158, 138],  // warm light grey
  [186, 176, 150],  // cream / off-white
  [120, 102, 84],   // taupe
  [142, 120, 98],   // soft tan
  [158, 150, 138],  // pale stone
  [110, 100, 88],   // warm grey
];

/* -------------------------------- traffic ------------------------------- */

export const MAX_CARS = 26;
export const MAX_PEDS = 30;
export const AGENT_CULL_D2 = 8100;     // squared cells

/* ------------------------------- defaults ------------------------------- */

export const DEFAULT_LAT = 40.71;
export const DEFAULT_LON = -74.00;
