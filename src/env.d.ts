/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly TMDB_API_KEY: string;
	readonly SUPABASE_URL: string;
	readonly SUPABASE_ANON_KEY: string;
	readonly SUPABASE_SERVICE_ROLE_KEY: string;
	readonly ADMIN_PASSWORD: string;
	readonly SESSION_SECRET: string;
	/** Bearer token for /api/books/sync — the KOReader plugin's only credential. */
	readonly READING_SYNC_TOKEN: string;
	/** Optional — see src/lib/jellyfin.ts. Absent means "no play button". */
	readonly JELLYFIN_URL?: string;
	readonly JELLYFIN_LOCAL_URL?: string;
	readonly JELLYFIN_API_KEY?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

interface Window {
	/**
	 * Start watching every `img[data-poster]` under `root` (the document by
	 * default), loading each one as it nears the viewport. Defined by
	 * components/PosterLoader.astro; pages that build tiles after load — the
	 * diary's and All films' infinite scroll — call it on what they just inserted.
	 * Optional at the call site: the loader is a separate module, so it may not
	 * have run yet when an early batch lands.
	 */
	observePosters?: (root?: ParentNode) => void;
}
