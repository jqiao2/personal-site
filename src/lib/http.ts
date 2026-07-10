// Tiny helpers for JSON API responses.

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
	});
}

export function apiError(message: string, status = 400): Response {
	return json({ error: message }, status);
}
