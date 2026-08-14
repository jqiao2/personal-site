// Plus codes (Open Location Code), because some restaurants are not in
// OpenStreetMap and never will be.
//
// WHY THIS EXISTS AT ALL, GIVEN THERE IS A GEOCODER. The geocoder answers
// "where is the place called X", which needs somebody to have put X in
// OpenStreetMap. A plus code answers nothing — it IS the coordinates, written
// in twenty letters instead of two decimals, so it works for a place that
// exists in no database at all. That is exactly the gap the by-hand form is
// for: a new restaurant, a stall, somewhere only Google has heard of.
//
// It also beats the alternative it sits next to. A Google Maps share link
// carries a street address and no coordinates, and a street address only
// becomes a point by being geocoded — which puts you back where you started,
// on a service that has the street but rarely the house number. A plus code
// skips the round trip and the guess: it decodes with arithmetic.
//
// TWO FORMS, AND ONLY ONE IS SELF-CONTAINED:
//
//   87G8Q2MM+2C          full, "global" — decodes on its own
//   Q2MM+2C Brooklyn     short — the first four characters were dropped, and
//                        only make sense near the place named after them
//
// Google shows the short form on a place page, because it is what a human can
// read out. Recovering it needs a reference point, which is what the locality
// after it is for — see recoverPlusCode, which the caller resolves through the
// same geocoder everything else here uses.

/** The code alphabet: 20 characters, chosen to avoid spelling words. */
const ALPHABET = '23456789CFGHJMPQRVWX';
const BASE = 20;
/** Characters before the separator in a full code. */
const SEPARATOR_POSITION = 8;
const SEPARATOR = '+';
const PADDING = '0';
/**
 * Beyond ten characters the cell is refined on a grid instead of 20×20, and
 * the grid is NOT square: five rows of latitude by four columns of longitude,
 * which is what keeps the cells nearly square on the ground at the latitudes
 * people live at. Reversing the two decodes every long code to the wrong
 * place by a few metres — close enough to look right and be wrong.
 */
const GRID_ROWS = 5;
const GRID_COLUMNS = 4;
/** Integer precision of a full 15-character code: 8000 · 5⁵ and 8000 · 4⁵. */
const FINAL_LAT_PRECISION = 8000 * GRID_ROWS ** 5;
const FINAL_LNG_PRECISION = 8000 * GRID_COLUMNS ** 5;
const MAX_DIGITS = 15;

// Zero characters before the separator is legal — "+2VX" is a code with all
// eight leading characters dropped, and only means anything within a few
// hundred metres of its reference.
const CODE = /^[23456789CFGHJMPQRVWX]*\+[23456789CFGHJMPQRVWX]*$/;

export interface Point {
	lat: number;
	lng: number;
}

/** Strip anything that isn't the code itself, and normalise case. */
function clean(raw: string): string {
	return raw.trim().toUpperCase();
}

/**
 * A code that carries its own position — eight characters, then the separator.
 *
 * Padded codes ("87G80000+") are accepted by the spec and describe an area the
 * size of a county; they are refused here, because a location this imprecise
 * is exactly what the unplaced state already says better.
 */
export function isFullPlusCode(raw: string): boolean {
	const code = clean(raw);
	if (!CODE.test(code)) return false;
	if (code.indexOf(SEPARATOR) !== SEPARATOR_POSITION) return false;
	if (code.includes(PADDING)) return false;
	// The first character bounds latitude, and only nine of twenty values are
	// legal there — 90° of latitude against 180° of longitude.
	return ALPHABET.indexOf(code[0]) < 9;
}

/** A code with its leading characters dropped: "Q2MM+2C". */
export function isShortPlusCode(raw: string): boolean {
	const code = clean(raw);
	if (!CODE.test(code)) return false;
	const sep = code.indexOf(SEPARATOR);
	return sep >= 0 && sep < SEPARATOR_POSITION && sep % 2 === 0;
}

/**
 * Pull a plus code out of a line of text, with whatever follows it.
 *
 * "Q2MM+2C Brooklyn, New York" is what Google puts on the clipboard, so the
 * locality is nearly always there — and it is the reference a short code needs
 * to be recovered.
 */
export function findPlusCode(raw: string): { code: string; locality: string } | null {
	const text = clean(raw).replace(/,/g, ' ');
	const match = text.match(/([23456789CFGHJMPQRVWX]{0,8}\+[23456789CFGHJMPQRVWX]{2,7})/);
	if (!match) return null;
	const code = match[1];
	if (!isFullPlusCode(code) && !isShortPlusCode(code)) return null;
	const locality = raw.slice(raw.toUpperCase().indexOf(code) + code.length).trim();
	return { code, locality: locality.replace(/^[,\s]+/, '') };
}

/**
 * Decode a full code to the CENTRE of the area it names.
 *
 * A code is an area, not a point — ten characters is about 14×14 metres, which
 * is a building — and its centre is the only defensible point to store. The
 * south-west corner would be off by half a cell in two directions, always in
 * the same direction, which is a bias rather than a rounding.
 */
export function decodePlusCode(raw: string): Point | null {
	const code = clean(raw);
	if (!isFullPlusCode(code)) return null;

	const digits = code.replace(SEPARATOR, '').slice(0, MAX_DIGITS);
	let lat = -90;
	let lng = -180;
	// The pair section: up to five pairs, each a twentieth of the one before.
	// `cell` trails one step behind the resolution, because the area a code
	// names is the size of the LAST pair it actually carries — a code that
	// stops at eight characters names a 0.0025° box, not a 0.000125° one.
	let latResolution = BASE;
	let lngResolution = BASE;
	let cellLat = BASE;
	let cellLng = BASE;
	let index = 0;
	for (; index + 1 < Math.min(digits.length, 10); index += 2) {
		lat += ALPHABET.indexOf(digits[index]) * latResolution;
		lng += ALPHABET.indexOf(digits[index + 1]) * lngResolution;
		cellLat = latResolution;
		cellLng = lngResolution;
		latResolution /= BASE;
		lngResolution /= BASE;
	}
	// Whatever is left refines that cell on the 5×4 grid, one character at a time.
	for (; index < digits.length; index += 1) {
		cellLat /= GRID_ROWS;
		cellLng /= GRID_COLUMNS;
		const value = ALPHABET.indexOf(digits[index]);
		lat += Math.floor(value / GRID_COLUMNS) * cellLat;
		lng += (value % GRID_COLUMNS) * cellLng;
	}

	// The centre of the smallest cell the code resolved to.
	return { lat: lat + cellLat / 2, lng: lng + cellLng / 2 };
}

/**
 * Turn a short code back into a full one, using a point near the place.
 *
 * The dropped characters are recoverable because a short code only ever means
 * somewhere within about half a degree of its locality: take the reference
 * point's own code, splice the short code into it, and nudge by a cell if that
 * landed on the far side of a boundary.
 */
export function recoverPlusCode(raw: string, refLat: number, refLng: number): string | null {
	const code = clean(raw);
	if (isFullPlusCode(code)) return code;
	if (!isShortPlusCode(code)) return null;

	const padding = SEPARATOR_POSITION - code.indexOf(SEPARATOR);
	const resolution = Math.pow(BASE, 2 - padding / 2);
	const half = resolution / 2;

	const lat = Math.min(89.99999, Math.max(-90, refLat));
	const lng = ((refLng + 180) % 360 + 360) % 360 - 180;
	const prefix = encodePrefix(lat, lng, padding);
	const candidate = prefix + code;

	const point = decodePlusCode(candidate);
	if (!point) return null;
	// Splicing can land a cell away when the reference sits near an edge.
	let latOut = point.lat;
	if (refLat + half < point.lat && point.lat - resolution >= -90) latOut = point.lat - resolution;
	else if (refLat - half > point.lat && point.lat + resolution <= 90) latOut = point.lat + resolution;

	let lngOut = point.lng;
	if (refLng + half < point.lng) lngOut = point.lng - resolution;
	else if (refLng - half > point.lng) lngOut = point.lng + resolution;

	return encode(latOut, lngOut, code.replace(SEPARATOR, '').length + padding);
}

/** The first `count` characters of the full code for a point. */
function encodePrefix(lat: number, lng: number, count: number): string {
	return encode(lat, lng, 10).replace(SEPARATOR, '').slice(0, count);
}

/** Encode a point to a full code of `length` digits (10 = building-sized). */
function encode(lat: number, lng: number, length = 10): string {
	const digits = Math.min(MAX_DIGITS, Math.max(2, length));
	let latitude = Math.min(90, Math.max(-90, lat));
	// A point exactly at the north pole would encode into the row past the last.
	if (latitude === 90) latitude -= 0.000001;
	const longitude = ((lng + 180) % 360 + 360) % 360 - 180;

	// Integer arithmetic throughout, as the reference implementation does:
	// floating point at the fifth grid character is the difference between a
	// code that round-trips and one that is off by a cell.
	let latValue = Math.floor(Math.round((latitude + 90) * FINAL_LAT_PRECISION * 1e6) / 1e6);
	let lngValue = Math.floor(Math.round((longitude + 180) * FINAL_LNG_PRECISION * 1e6) / 1e6);

	let code = '';
	// The grid section first, from the least significant character.
	for (let i = 0; i < 5; i += 1) {
		code = ALPHABET[(latValue % GRID_ROWS) * GRID_COLUMNS + (lngValue % GRID_COLUMNS)] + code;
		latValue = Math.floor(latValue / GRID_ROWS);
		lngValue = Math.floor(lngValue / GRID_COLUMNS);
	}
	for (let i = 0; i < 5; i += 1) {
		code = ALPHABET[latValue % BASE] + ALPHABET[lngValue % BASE] + code;
		latValue = Math.floor(latValue / BASE);
		lngValue = Math.floor(lngValue / BASE);
	}
	return `${code.slice(0, SEPARATOR_POSITION)}${SEPARATOR}${code.slice(SEPARATOR_POSITION, digits)}`;
}
