// Jellyfin runs on the home machine and is reachable only over Tailscale. That
// inverts how this integration works compared to every other one here: a Vercel
// function can't join the tailnet, so it can never ask Jellyfin anything. The
// browser reading the page can — when it's on a device that's signed in. So the
// library lookup and the play command both happen client-side, and this module's
// only job is to hand the film page the config those calls need.
//
// The consequence is that JELLYFIN_API_KEY reaches the client. Three things keep
// that acceptable: it's emitted only for an authenticated owner session (callers
// must gate on requireOwner), it's inert to anyone not on the tailnet, and it's
// revocable from Jellyfin's dashboard. It is still a full-access key, so revoke
// it if a device is lost.

export type JellyfinConfig = {
	/**
	 * Origins to try, in no particular order — the client uses whichever answers
	 * first. There are two because no single URL reaches Jellyfin from everywhere:
	 *
	 *  - The tailnet name works from your phone, laptop, anything else signed in.
	 *    It does NOT work from the machine Jellyfin runs on: a node can't reach its
	 *    own `tailscale serve` endpoint (verified — the TCP connect just times out).
	 *  - localhost works only on that machine, which is precisely the gap above,
	 *    and is also where the desktop player lives.
	 *
	 * Neither is redundant, and probing is cheap, so the client tries both.
	 */
	baseUrls: string[];
	/** API key from Jellyfin's Dashboard → API Keys. */
	apiKey: string;
};

/**
 * Jellyfin config for the film page, or null when it isn't configured. Null is
 * the normal state, not an error: without a key and at least one URL the page
 * never shows a play button and the YTS download link stands on its own,
 * exactly as before this existed.
 */
export function jellyfinConfig(): JellyfinConfig | null {
	const apiKey = import.meta.env.JELLYFIN_API_KEY?.trim();
	const baseUrls = [import.meta.env.JELLYFIN_URL, import.meta.env.JELLYFIN_LOCAL_URL]
		.map((u) => u?.trim().replace(/\/+$/, ''))
		.filter((u): u is string => !!u);
	if (!apiKey || baseUrls.length === 0) return null;
	return { baseUrls, apiKey };
}
