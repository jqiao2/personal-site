// skeleton-tracing-wasm ships no types. We use exactly one entry point: load the
// WASM tracer, then trace a binary image into polylines. See src/lib/line-art.ts.
declare module 'skeleton-tracing-wasm' {
	interface Traced {
		polylines: [number, number][][];
		rects: number[][];
	}
	class TraceSkeleton {
		static load(): Promise<TraceSkeleton>;
		fromBoolArray(arr: ArrayLike<number>, w: number, h: number): Traced;
		fromImageData(img: ImageData): Traced;
		fromCharString(str: string, w: number, h: number): Traced;
	}
	export default TraceSkeleton;
}
