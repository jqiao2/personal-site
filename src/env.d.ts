/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly TMDB_API_KEY: string;
	readonly SUPABASE_URL: string;
	readonly SUPABASE_ANON_KEY: string;
	readonly SUPABASE_SERVICE_ROLE_KEY: string;
	readonly ADMIN_PASSWORD: string;
	readonly SESSION_SECRET: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
