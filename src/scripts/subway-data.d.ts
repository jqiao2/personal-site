// Hand-written types for the auto-generated subway-data.js. The generator
// (scripts/generate-subway-data.mjs) only rewrites the .js, so this file stays put.
// Without it TypeScript infers the shapes from the literals, which loses the
// station-id → object indexing the map page does and hides real mistakes in noise.

/** The schematic canvas the coordinates are laid out in (north up, not geographic). */
export declare const CANVAS: { W: number; H: number };

/** One service (1, 2, 3, A, C, E, … SIR) and the trunk line it shares a colour with. */
export interface SubwayService {
	svc: string;
	trunk: string;
	color: string;
}
export declare const SERVICES: SubwayService[];

/** One station complex, at its schematic position, with the services that stop there. */
export interface SubwayStation {
	id: number;
	name: string;
	x: number;
	y: number;
	svcs: string[];
}
export declare const STATIONS: SubwayStation[];

/**
 * One service's track between two adjacent stations. `o` is the offset index that
 * fans parallel services apart; `pts` is the polyline in canvas coordinates.
 *
 * `_n` (per-vertex unit normals) is not in the generated data — src/pages/subway.astro
 * computes it onto every segment before the first draw, so it is typed as present.
 */
export interface SubwaySegment {
	id: string;
	svc: string;
	o: number;
	color: string;
	a: number;
	b: number;
	pts: number[][];
	_n: number[][];
}
export declare const SEGMENTS: SubwaySegment[];
