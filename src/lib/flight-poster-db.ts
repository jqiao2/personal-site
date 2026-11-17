// The flight poster's one row in Supabase (migration 0082). Service role only:
// callers check requireOwner() or the board's bearer token first.
import { supabaseAdmin } from './supabase';
import { posterRow, type BoardStatus, type PosterCity, type PosterConfig, type PosterRow } from './flight-poster';

export async function getPoster(): Promise<PosterRow> {
	const { data, error } = await supabaseAdmin
		.from('flight_poster')
		.select('config, pending_show, status, cities, synced_at')
		.eq('id', 1)
		.single();

	if (error) throw new Error(error.message);

	return posterRow.parse(data);
}

async function update(fields: Partial<Omit<PosterRow, 'config'>> & { config?: PosterConfig }): Promise<void> {
	const { error } = await supabaseAdmin.from('flight_poster').update(fields).eq('id', 1);

	if (error) throw new Error(error.message);
}

export const saveConfig = (config: PosterConfig): Promise<void> => update({ config });

export const setPendingShow = (slug: string | null): Promise<void> => update({ pending_show: slug });

/** Store what the board reported and hand back what it should do next. A
 *  pending show is delivered once: it is cleared here, and only if the owner
 *  hasn't picked another city since this read. */
export async function syncBoard(
	status: BoardStatus,
	cities: PosterCity[],
): Promise<{ config: PosterConfig; show: string | null }> {
	const row = await getPoster();

	await update({ status, cities, synced_at: new Date().toISOString() });

	if (row.pending_show) {
		const { error } = await supabaseAdmin
			.from('flight_poster')
			.update({ pending_show: null })
			.eq('id', 1)
			.eq('pending_show', row.pending_show);

		if (error) throw new Error(error.message);
	}

	return { config: row.config, show: row.pending_show };
}
