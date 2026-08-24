/**
 * A small, hand-authored OpenStreetMap-style extract for a fictional-but-plausible
 * downtown block. It is NOT real survey data; it exists so the OSM renderer has
 * something to draw the moment the page opens, without depending on a live
 * Overpass mirror (which is frequently overloaded or unreachable).
 *
 * The shape matches exactly what `OsmWorld` consumes: Overpass "out geom"
 * elements. Geometry is an array of { lat, lon } objects (the real Overpass
 * format), so the road graph, junctions, traffic signals, street signs, and
 * crosswalks all resolve to real world coordinates. Standalone `traffic_signals`
 * nodes carry lat/lon directly. Buildings carry `height`/`building:levels`, named
 * streets carry `name` + `highway`, and one tower carries a `wikipedia` tag so
 * the landmark/info-panel path is exercised too.
 *
 * This is the offline "Demo City" preset. Live Overpass remains the path for
 * real places typed into the picker.
 */

export const DEMO_BBOX = [40.7400, -73.9900, 40.7520, -73.9750];

// Helper: Overpass "out geom" stores coordinates as { lat, lon } objects.
const pt = (lat, lon) => ({ lat, lon });

export const DEMO_ELEMENTS = [
  // ---- streets (named, so the street-label layer has something to say) ----
  // Intersections share exact vertices so the road graph joins them into real
  // junctions (the renderer keys signals, signs, and crosswalks off those).
  {
    type: 'way', id: 1, tags: { highway: 'primary', name: 'Market Street' },
    geometry: [
      pt(40.7400, -73.9900), pt(40.7440, -73.9875), pt(40.7460, -73.9865),
      pt(40.7480, -73.9850), pt(40.7510, -73.9825), pt(40.7520, -73.9800),
    ],
  },
  {
    type: 'way', id: 2, tags: { highway: 'secondary', name: 'Canal Street' },
    geometry: [
      pt(40.7460, -73.9900), pt(40.7460, -73.9880), pt(40.7460, -73.9830),
      pt(40.7460, -73.9800), pt(40.7460, -73.9750),
    ],
  },
  {
    type: 'way', id: 3, tags: { highway: 'residential', name: 'Oak Avenue' },
    geometry: [
      pt(40.7400, -73.9880), pt(40.7440, -73.9880), pt(40.7460, -73.9880),
      pt(40.7480, -73.9880), pt(40.7520, -73.9880),
    ],
  },
  {
    type: 'way', id: 4, tags: { highway: 'residential', name: 'Elm Avenue' },
    geometry: [
      pt(40.7400, -73.9830), pt(40.7440, -73.9830), pt(40.7460, -73.9830),
      pt(40.7480, -73.9830), pt(40.7520, -73.9830),
    ],
  },
  {
    type: 'way', id: 5, tags: { highway: 'pedestrian', name: 'Plaza Walk' },
    geometry: [
      pt(40.7460, -73.9860), pt(40.7460, -73.9840),
    ],
  },

  // ---- traffic signals at the main intersections ----
  { type: 'node', id: 101, lat: 40.7460, lon: -73.9880, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 102, lat: 40.7460, lon: -73.9830, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 103, lat: 40.7440, lon: -73.9880, tags: { highway: 'traffic_signals' } },

  // ---- buildings: a mix of heights, one landmark with a Wikipedia link ----
  {
    type: 'way', id: 201, tags: { building: 'yes', name: 'Meridian Tower',
      'building:levels': '22', height: '84', wikipedia: 'en:Meridian Tower' },
    geometry: [
      pt(40.7472, -73.9892), pt(40.7472, -73.9878), pt(40.7486, -73.9878), pt(40.7486, -73.9892), pt(40.7472, -73.9892),
    ],
  },
  {
    type: 'way', id: 202, tags: { building: 'yes', 'building:levels': '12', height: '46' },
    geometry: [
      pt(40.7472, -73.9868), pt(40.7472, -73.9856), pt(40.7484, -73.9856), pt(40.7484, -73.9868), pt(40.7472, -73.9868),
    ],
  },
  {
    type: 'way', id: 203, tags: { building: 'yes', 'building:levels': '8', height: '30' },
    geometry: [
      pt(40.7472, -73.9842), pt(40.7472, -73.9830), pt(40.7482, -73.9830), pt(40.7482, -73.9842), pt(40.7472, -73.9842),
    ],
  },
  {
    type: 'way', id: 204, tags: { building: 'yes', 'building:levels': '6', height: '23' },
    geometry: [
      pt(40.7430, -73.9892), pt(40.7430, -73.9878), pt(40.7442, -73.9878), pt(40.7442, -73.9892), pt(40.7430, -73.9892),
    ],
  },
  {
    type: 'way', id: 205, tags: { building: 'yes', 'building:levels': '5', height: '19' },
    geometry: [
      pt(40.7430, -73.9868), pt(40.7430, -73.9856), pt(40.7440, -73.9856), pt(40.7440, -73.9868), pt(40.7430, -73.9868),
    ],
  },
  {
    type: 'way', id: 206, tags: { building: 'yes', 'building:levels': '4', height: '15' },
    geometry: [
      pt(40.7430, -73.9842), pt(40.7430, -73.9830), pt(40.7440, -73.9830), pt(40.7440, -73.9842), pt(40.7430, -73.9842),
    ],
  },
  {
    type: 'way', id: 207, tags: { building: 'yes', 'building:levels': '9', height: '34' },
    geometry: [
      pt(40.7410, -73.9892), pt(40.7410, -73.9878), pt(40.7422, -73.9878), pt(40.7422, -73.9892), pt(40.7410, -73.9892),
    ],
  },
  {
    type: 'way', id: 208, tags: { building: 'yes', 'building:levels': '7', height: '27' },
    geometry: [
      pt(40.7410, -73.9868), pt(40.7410, -73.9856), pt(40.7420, -73.9856), pt(40.7420, -73.9868), pt(40.7410, -73.9868),
    ],
  },
  {
    type: 'way', id: 209, tags: { building: 'yes', 'building:levels': '5', height: '19' },
    geometry: [
      pt(40.7410, -73.9842), pt(40.7410, -73.9830), pt(40.7420, -73.9830), pt(40.7420, -73.9842), pt(40.7410, -73.9842),
    ],
  },
  {
    type: 'way', id: 210, tags: { building: 'yes', 'building:levels': '3', height: '11' },
    geometry: [
      pt(40.7472, -73.9818), pt(40.7472, -73.9806), pt(40.7482, -73.9806), pt(40.7482, -73.9818), pt(40.7472, -73.9818),
    ],
  },
  {
    type: 'way', id: 211, tags: { building: 'yes', 'building:levels': '4', height: '15' },
    geometry: [
      pt(40.7430, -73.9818), pt(40.7430, -73.9806), pt(40.7440, -73.9806), pt(40.7440, -73.9818), pt(40.7430, -73.9818),
    ],
  },

  // ---- a little green space so the ground layer has variety ----
  {
    type: 'way', id: 301, tags: { leisure: 'park', name: 'Civic Green' },
    geometry: [
      pt(40.7452, -73.9862), pt(40.7452, -73.9848), pt(40.7468, -73.9848), pt(40.7468, -73.9862), pt(40.7452, -73.9862),
    ],
  },
];
