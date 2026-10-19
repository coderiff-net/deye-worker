interface Env {
	PROXY_TEST_TOKEN?: string;
	DEYE_APP_ID?: string;
	DEYE_APP_SECRET?: string;
	DEYE_EMAIL?: string;
	DEYE_PASSWORD?: string;
	DEYE_BASE_URL?: string;
}

const DEFAULT_DEYE_BASE_URL = 'https://eu1-developer.deyecloud.com/v1.0';

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function isAuthorized(request: Request, expectedToken: string): boolean {
	return request.headers.get('Authorization') === `Bearer ${expectedToken}`;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deyeBaseUrl(value: string | undefined): URL | null {
	try {
		const url = new URL(value || DEFAULT_DEYE_BASE_URL);
		if (url.protocol !== 'https:' || !url.hostname.endsWith('.deyecloud.com')) return null;
		url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
		return url;
	} catch {
		return null;
	}
}

async function fetchDeyeStations(env: Env): Promise<Response> {
	const missing = ['DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD'].filter(
		(name) => !env[name as keyof Env],
	);
	if (missing.length) return json({ error: 'Worker is missing Deye credentials', missing }, 503);

	const baseUrl = deyeBaseUrl(env.DEYE_BASE_URL);
	if (!baseUrl) return json({ error: 'DEYE_BASE_URL must be an HTTPS DeyeCloud host' }, 500);

	try {
		const tokenUrl = new URL('account/token', baseUrl);
		tokenUrl.searchParams.set('appId', env.DEYE_APP_ID!);
		const tokenResponse = await fetch(tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				appSecret: env.DEYE_APP_SECRET,
				email: env.DEYE_EMAIL,
				password: await sha256(env.DEYE_PASSWORD!),
			}),
		});
		const tokenData = (await tokenResponse.json()) as {
			accessToken?: string;
			code?: string | number;
			msg?: string;
			success?: boolean;
		};
		if (!tokenResponse.ok || !tokenData.accessToken || tokenData.success === false) {
			return json(
				{ error: 'Deye authentication failed', upstreamStatus: tokenResponse.status, code: tokenData.code, message: tokenData.msg },
				502,
			);
		}

		const accessToken = tokenData.accessToken.startsWith('Bearer ')
			? tokenData.accessToken
			: `Bearer ${tokenData.accessToken}`;
		const stationResponse = await fetch(new URL('station/list', baseUrl), {
			method: 'POST',
			headers: {
				Authorization: accessToken,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ page: 1, size: 10 }),
		});
		const responseBody = await stationResponse.text();
		return new Response(responseBody, {
			status: stationResponse.status,
			headers: { 'Content-Type': stationResponse.headers.get('Content-Type') || 'application/json' },
		});
	} catch {
		return json({ error: 'Could not reach DeyeCloud API' }, 502);
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/' && request.method === 'GET') return new Response('Hello World!');
		if (url.pathname !== '/api/stations') return json({ error: 'Not found' }, 404);
		if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
		if (!env.PROXY_TEST_TOKEN) return json({ error: 'Worker is missing PROXY_TEST_TOKEN' }, 503);
		if (!isAuthorized(request, env.PROXY_TEST_TOKEN)) return json({ error: 'Unauthorized' }, 401);
		return fetchDeyeStations(env);
	},
} satisfies ExportedHandler<Env>;
