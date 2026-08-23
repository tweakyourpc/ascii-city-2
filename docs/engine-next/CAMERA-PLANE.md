# Camera-Plane Projection

Engine Next replaces linear angular ray stepping with a conventional pinhole
camera plane. This is a ray-table change, not a raycaster rewrite.

For facing vector `F`, clockwise right vector `R`, horizontal FOV `f`, and a
screen coordinate `u` from -1 at the left boundary to +1 at the right boundary:

```text
rawRay = F + R * u * tan(f / 2)
ray = normalize(rawRay)
```

`rawRay` has a forward component of exactly one. Its length is therefore the
same reciprocal-cosine factor the existing DDA uses to convert unit-ray distance
to perpendicular camera depth. Facade, floor, roof, picking, and depth-buffer
code keep their established contract.

The previous linear-angle fan and the pinhole projection used by roads, labels,
sprites, aircraft, and sky disagreed by up to about 1.50 degrees at the current
FOV. The camera-plane table is now the exact inverse of those projections.

Tests cover:

- centre and exact boundary directions;
- full horizontal FOV;
- normalized, symmetric rays;
- projection of every sampled ray back to its source column centre;
- reciprocal forward-depth correction;
- a semantic skyline snapshot containing a low foreground building and taller
  structures behind it.

Expected visual change is confined to horizontal perspective. Mid-field facades
and overlaid semantic geometry should align more consistently while the centre
and view boundaries remain fixed. Material selection, world data, vertical
projection, and skyline coverage are unchanged.
