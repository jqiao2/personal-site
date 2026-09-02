// Title-casing the health department's block-capital names.
//
// The awning case is unrecoverable from all caps, so this only checks the
// guess is the sensible one: words up, interior small words down, apostrophes
// and digits left where they are.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/gazetteer.test.mjs
import assert from 'node:assert/strict';

// gazetteer.ts pulls in the Supabase client at load; give it something to
// construct so importing the pure helper needs no real credentials.
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_ANON_KEY ??= 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
const { titleCaseName } = await import('../src/lib/gazetteer.ts');

const cases = [
	['SABOR LATINO SPANISH AMERICAN', 'Sabor Latino Spanish American'],
	['POKE BOWL STATION', 'Poke Bowl Station'],
	["POKE N' ROLL", "Poke N' Roll"],
	['99 FAVOR TASTE', '99 Favor Taste'],
	['OKI POKE & RAMEN', 'Oki Poke & Ramen'],
	['HOUSE OF THE DRAGON', 'House of the Dragon'],
	['TAQUERIA EL FOGON', 'Taqueria el Fogon'],
	["WU'S WONTON KING", "Wu's Wonton King"],
	// First and last word keep their capital even when they are small words.
	['THE HOUSE', 'The House'],
	// Acronyms stay shouting.
	['KPOT KOREAN BBQ & HOT POT', 'Kpot Korean BBQ & Hot Pot'],
];

for (const [raw, want] of cases) {
	assert.equal(titleCaseName(raw), want, `${raw} → ${titleCaseName(raw)} (wanted ${want})`);
}

console.log(`ok — ${cases.length} names title-cased`);
