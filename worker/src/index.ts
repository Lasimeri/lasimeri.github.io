// crystal — utility worker for seaof.glass

interface Env {
	STORE: R2Bucket;
}

const DOMAIN = 'seaof.glass';
const ALLOWED_ORIGINS = [`https://${DOMAIN}`, 'http://localhost:8080'];

// Rate limiting
const rateMap = new Map<string, number[]>();
const RATE_LIMIT = 15;
const RATE_WINDOW = 60_000;

function rateOk(ip: string): boolean {
	const now = Date.now();
	const hits = (rateMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
	if (hits.length >= RATE_LIMIT) return false;
	hits.push(now);
	rateMap.set(ip, hits);
	return true;
}

function cors(res: Response, origin?: string): Response {
	const h = new Headers(res.headers);
	const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : `https://${DOMAIN}`;
	h.set('Access-Control-Allow-Origin', allowed);
	h.set('Access-Control-Allow-Methods', 'POST, DELETE, GET, OPTIONS');
	h.set('Access-Control-Allow-Headers', 'Content-Type');
	h.set('Access-Control-Max-Age', '86400');
	h.set('Vary', 'Origin');
	return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200, origin?: string): Response {
	return cors(new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	}), origin);
}

function err(msg: string, status = 400): Response {
	return json({ error: msg }, status);
}

function text(body: string, origin?: string): Response {
	return cors(new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), origin);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || undefined;

		if (request.method === 'OPTIONS') {
			return cors(new Response(null, { status: 204 }), origin);
		}

		const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
		if (!rateOk(ip)) return err('rate limited', 429);

		// ── GET /s/ip ───────────────────────────────
		if (request.method === 'GET' && url.pathname === '/s/ip') {
			return text(ip, origin);
		}

		// ── GET /s/headers ──────────────────────────
		if (request.method === 'GET' && url.pathname === '/s/headers') {
			const hdrs: Record<string, string> = {};
			for (const [k, v] of request.headers) hdrs[k] = v;
			return json(hdrs, 200, origin);
		}

		// ── GET /s/dns/:type/:domain ────────────────
		if (request.method === 'GET' && url.pathname.startsWith('/s/dns/')) {
			const parts = url.pathname.slice(7).split('/');
			if (parts.length < 2) return err('usage: /s/dns/:type/:domain');
			const qtype = parts[0].toUpperCase();
			const domain = parts.slice(1).join('/');
			const allowed = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA'];
			if (!allowed.includes(qtype)) return err('unsupported type. allowed: ' + allowed.join(', '));
			if (!domain) return err('missing domain');
			const dohRes = await fetch(
				`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${qtype}`,
				{ headers: { 'Accept': 'application/dns-json' } },
			);
			if (!dohRes.ok) return err('doh query failed: ' + dohRes.status, 502);
			const dohData = await dohRes.json();
			return json(dohData, 200, origin);
		}

		// ── GET /s/ping/:url ────────────────────────
		if (request.method === 'GET' && url.pathname.startsWith('/s/ping/')) {
			let target = decodeURIComponent(url.pathname.slice(8));
			if (!target) return err('missing url');
			if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 5000);
				const t0 = Date.now();
				const pingRes = await fetch(target, { signal: controller.signal, redirect: 'follow' });
				const t1 = Date.now();
				clearTimeout(timer);
				const resHeaders: Record<string, string> = {};
				for (const [k, v] of pingRes.headers) resHeaders[k] = v;
				return json({ url: target, status: pingRes.status, time_ms: t1 - t0, headers: resHeaders }, 200, origin);
			} catch (e: any) {
				return json({ url: target, error: e.message || 'fetch failed' }, 200, origin);
			}
		}

		// ── GET /s/whois/:domain ────────────────────
		if (request.method === 'GET' && url.pathname.startsWith('/s/whois/')) {
			const domain = url.pathname.slice(9);
			if (!domain) return err('missing domain');
			try {
				const rdapRes = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
				if (!rdapRes.ok) return err('rdap lookup failed: ' + rdapRes.status, 502);
				const rdapData = await rdapRes.json();
				return json(rdapData, 200, origin);
			} catch (e: any) {
				return json({ error: e.message || 'rdap fetch failed' }, 502, origin);
			}
		}

		// ── GET /s/b64/encode/:text ─────────────────
		if (request.method === 'GET' && url.pathname.startsWith('/s/b64/encode/')) {
			const t = decodeURIComponent(url.pathname.slice(14));
			const encoded = btoa(unescape(encodeURIComponent(t)));
			return text(encoded, origin);
		}

		// ── GET /s/b64/decode/:text ─────────────────
		if (request.method === 'GET' && url.pathname.startsWith('/s/b64/decode/')) {
			const raw = decodeURIComponent(url.pathname.slice(14));
			try {
				const safe = raw.replace(/-/g, '+').replace(/_/g, '/');
				const padded = safe + '='.repeat((4 - safe.length % 4) % 4);
				const decoded = decodeURIComponent(escape(atob(padded)));
				return text(decoded, origin);
			} catch {
				return err('invalid base64');
			}
		}

		// ── POST /s/go + GET /s/go/:id — URL shortener ──
		if (request.method === 'POST' && url.pathname === '/s/go') {
			let body: any;
			try { body = await request.json(); } catch { return err('invalid json'); }
			if (!body.url || typeof body.url !== 'string') return err('missing url');
			try { new URL(body.url); } catch { return err('invalid url'); }
			const idBytes = new Uint8Array(3);
			crypto.getRandomValues(idBytes);
			const shortId = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
			await env.STORE.put(`short:${shortId}`, body.url);
			return json({ id: shortId, url: `https://${DOMAIN}/s/go/${shortId}` }, 201, origin);
		}
		if (request.method === 'GET' && url.pathname.startsWith('/s/go/')) {
			const shortId = url.pathname.slice(6);
			if (!shortId) return err('missing id');
			const obj = await env.STORE.get(`short:${shortId}`);
			if (!obj) return err('not found', 404);
			const target = await obj.text();
			return cors(new Response(null, { status: 301, headers: { 'Location': target } }), origin);
		}

		// ── POST /s/tmp + GET /s/tmp/:id — temp file drop ──
		if (request.method === 'POST' && url.pathname === '/s/tmp') {
			const cl = request.headers.get('content-length');
			if (cl && parseInt(cl, 10) > 10485760) return err('file too large (10MB max)', 413);
			const contentType = request.headers.get('content-type') || 'application/octet-stream';
			const idBytes = new Uint8Array(3);
			crypto.getRandomValues(idBytes);
			const tmpId = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
			const expires = Date.now() + 3600000;
			const bodyData = await request.arrayBuffer();
			if (bodyData.byteLength > 10485760) return err('file too large (10MB max)', 413);
			await env.STORE.put(`tmp:${tmpId}`, bodyData, {
				customMetadata: { contentType, expires: String(expires) },
			});
			return json({ id: tmpId, url: `https://${DOMAIN}/s/tmp/${tmpId}`, expires }, 201, origin);
		}
		if (request.method === 'GET' && url.pathname.startsWith('/s/tmp/')) {
			const tmpId = url.pathname.slice(7);
			if (!tmpId) return err('missing id');
			const obj = await env.STORE.get(`tmp:${tmpId}`);
			if (!obj) return err('not found', 404);
			const meta = obj.customMetadata || {};
			const expires = parseInt(meta.expires || '0', 10);
			if (expires && Date.now() > expires) {
				await env.STORE.delete(`tmp:${tmpId}`);
				return err('expired', 410);
			}
			const ct = meta.contentType || 'application/octet-stream';
			return cors(new Response(obj.body, { headers: { 'Content-Type': ct } }), origin);
		}

		// ── GET /s/proxy — CORS proxy ───────────────
		if (url.pathname === '/s/proxy' && (request.method === 'GET' || request.method === 'OPTIONS')) {
			if (request.method === 'OPTIONS') {
				const h = new Headers();
				h.set('Access-Control-Allow-Origin', '*');
				h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
				h.set('Access-Control-Allow-Headers', '*');
				h.set('Access-Control-Max-Age', '86400');
				return new Response(null, { status: 204, headers: h });
			}
			const targetUrl = url.searchParams.get('url');
			if (!targetUrl) return err('missing ?url= parameter');
			let parsed: URL;
			try { parsed = new URL(targetUrl); } catch { return err('invalid url'); }
			if (!['http:', 'https:'].includes(parsed.protocol)) return err('only http/https');
			const host = parsed.hostname;
			if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|localhost|::1|\[::1\])/.test(host)) {
				return err('private addresses blocked');
			}
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 5000);
				const proxyRes = await fetch(targetUrl, {
					signal: controller.signal,
					headers: { 'User-Agent': 'seaofglass-proxy/1.0' },
					redirect: 'follow',
				});
				clearTimeout(timeout);
				const body = await proxyRes.arrayBuffer();
				if (body.byteLength > 1048576) return err('response too large (1MB max)', 413);
				const h = new Headers();
				h.set('Access-Control-Allow-Origin', '*');
				h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
				h.set('Access-Control-Allow-Headers', '*');
				h.set('Content-Type', proxyRes.headers.get('Content-Type') || 'application/octet-stream');
				h.set('X-Proxy-Status', String(proxyRes.status));
				return new Response(body, { status: proxyRes.status, headers: h });
			} catch (e: any) {
				return err('proxy error: ' + e.message, 502);
			}
		}

		return err('not found', 404);
	},
};
