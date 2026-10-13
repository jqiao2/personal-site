// The owner's subway log (migration 0071): visited stations and ridden track
// segments, keyed by the ids in src/scripts/subway-data.js. Owner-only — the
// API checks requireOwner before calling anything here.
import { supabaseAdmin } from './supabase';

export type MarkKind = 'station' | 'segment';

export interface SubwayMarks {
	st: string[];
	seg: string[];
}

export async function getMarks(): Promise<SubwayMarks> {
	const { data, error } = await supabaseAdmin.from('subway_marks').select('kind, ref');

	if (error) throw new Error(error.message);

	return {
		st: data.filter((r) => r.kind === 'station').map((r) => r.ref),
		seg: data.filter((r) => r.kind === 'segment').map((r) => r.ref),
	};
}

export async function setMark(kind: MarkKind, ref: string, on: boolean): Promise<void> {
	const { error } = on
		? await supabaseAdmin.from('subway_marks').upsert({ kind, ref }, { onConflict: 'kind,ref', ignoreDuplicates: true })
		: await supabaseAdmin.from('subway_marks').delete().eq('kind', kind).eq('ref', ref);

	if (error) throw new Error(error.message);
}

/** Replace the whole log — an import, or the one-time upload of a browser's old local log. */
export async function replaceMarks(marks: SubwayMarks): Promise<void> {
	const { error: delError } = await supabaseAdmin.from('subway_marks').delete().neq('ref', '');

	if (delError) throw new Error(delError.message);

	const rows = [
		...marks.st.map((ref) => ({ kind: 'station' as const, ref })),
		...marks.seg.map((ref) => ({ kind: 'segment' as const, ref })),
	];

	if (!rows.length) return;
	const { error } = await supabaseAdmin.from('subway_marks').insert(rows);

	if (error) throw new Error(error.message);
}
