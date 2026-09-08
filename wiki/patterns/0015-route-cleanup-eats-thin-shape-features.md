# Route cleanup eats thin shape features (peninsulas)

- **Type:** failure-mode
- **Applies when:** a traced outline route loses genuine thin features (Florida,
  Maine, a panhandle) — the outline shows them but the routed line cuts across.

## What happens

`removeLoops` in `src/lib/bike-route.ts` splices out any near-return excursion
(down one road, back up a parallel one within `tol` = 70 m, over a path much
longer than the chord). That's exactly the signature of a real thin peninsula,
not just a router lasso — so at small map scale (a whole country squeezed into a
few km, spacing 0.5 km) Florida and Maine get deleted. `removeBacktracks` does
the same to a peninsula whose down and up legs use the *identical* road nodes.

## Root cause

The cleanup passes had no way to tell an *intended* thin feature from a router
artifact. Both look like a near-return.

## Fix

Make the cleanup waypoint-aware. A real peninsula carries a **run of the
outline's own sample waypoints** down and back; a router lasso between two
consecutive waypoints carries **none** in between. `routeWaypoints` now builds
`anchorKeySet(coords, waypoints)` (the key of the route point nearest each
waypoint) and passes it to `removeLoops`, which refuses to splice an excursion
holding **two or more** anchors. One-or-fewer (a lone stray/notch waypoint) is
still cut, so ordinary artifact cleanup is unchanged. Finer spacing → more
anchors on a feature → better preservation, which is the right direction.

`removeBacktracks` was left as-is: it only bites an *exact* same-node out-and-back,
which for a gridded city is degenerate and rare. If a single-road dead-end
peninsula ever disappears, give `removeBacktracks` the same anchor guard.

## Check

Synthetic 40 m-wide, 1500 m peninsula with waypoints marching down/up survives
anchor-aware `removeLoops` (reaches −1500 m); a single-waypoint lasso still
collapses to 0. See the commit's scratchpad check.
