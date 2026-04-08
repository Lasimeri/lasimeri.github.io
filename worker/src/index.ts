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
				// Try RDAP bootstrap via rdap.org, fall back to Cloudflare RDAP
				let rdapRes = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
					headers: { 'User-Agent': 'seaofglass-rdap/1.0', 'Accept': 'application/rdap+json' },
				});
				if (!rdapRes.ok) {
					// Fall back to ARIN RDAP for .com/.net/.org
					const tld = domain.split('.').pop()?.toLowerCase();
					const registryMap: Record<string, string> = {
						com: 'https://rdap.verisign.com/com/v1',
						net: 'https://rdap.verisign.com/net/v1',
						org: 'https://rdap.org/domain',
					};
					const base = registryMap[tld || ''] || 'https://rdap.org/domain';
					rdapRes = await fetch(`${base}/${encodeURIComponent(domain)}`, {
						headers: { 'User-Agent': 'seaofglass-rdap/1.0', 'Accept': 'application/rdap+json' },
					});
				}
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

		// ── GET /s/tunnel — web proxy with HTMLRewriter ──
		if (url.pathname.startsWith('/s/tunnel')) {
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
				const timeout = setTimeout(() => controller.abort(), 10000);

				const proxyRes = await fetch(targetUrl, {
					signal: controller.signal,
					headers: {
						'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
						'Accept': request.headers.get('Accept') || 'text/html,*/*',
						'Accept-Language': request.headers.get('Accept-Language') || 'en-US,en;q=0.9',
					},
					redirect: 'follow',
				});
				clearTimeout(timeout);

				const contentType = proxyRes.headers.get('Content-Type') || '';
				const proxyBase = `https://${DOMAIN}/s/tunnel?url=`;
				const targetOrigin = parsed.origin;

				// Non-HTML: pass through directly (images, CSS, JS, fonts, etc.)
				if (!contentType.includes('text/html')) {
					const h = new Headers();
					h.set('Content-Type', contentType);
					h.set('Access-Control-Allow-Origin', '*');
					h.set('Cache-Control', 'public, max-age=300');
					return new Response(proxyRes.body, { headers: h });
				}

				// HTML: rewrite URLs with HTMLRewriter + inject JS shim
				const resolveUrl = (relative: string) => {
					try {
						if (relative.startsWith('data:') || relative.startsWith('javascript:') || relative.startsWith('#') || relative.startsWith('mailto:')) return relative;
						const abs = new URL(relative, targetUrl).href;
						return proxyBase + encodeURIComponent(abs);
					} catch { return relative; }
				};

				// JS shim injected into <head> to intercept dynamic requests
				const jsShim = `<script>
(function(){
  const _pbase = ${JSON.stringify(proxyBase)};
  const _torigin = ${JSON.stringify(targetOrigin)};
  const _turl = ${JSON.stringify(targetUrl)};

  // Rewrite fetch
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      try {
        const abs = new URL(input, _turl).href;
        if (abs.startsWith('http')) input = _pbase + encodeURIComponent(abs);
      } catch {}
    } else if (input instanceof Request) {
      try {
        const abs = new URL(input.url, _turl).href;
        if (abs.startsWith('http')) input = new Request(_pbase + encodeURIComponent(abs), input);
      } catch {}
    }
    return _fetch.call(this, input, init);
  };

  // Rewrite XMLHttpRequest
  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, xhrUrl, ...args) {
    try {
      const abs = new URL(xhrUrl, _turl).href;
      if (abs.startsWith('http')) xhrUrl = _pbase + encodeURIComponent(abs);
    } catch {}
    return _xhrOpen.call(this, method, xhrUrl, ...args);
  };

  // Rewrite window.location reads
  try {
    const _loc = new URL(_turl);
    Object.defineProperty(document, 'domain', { get: () => _loc.hostname });
  } catch {}
})();
</script>`;

				const rewriter = new HTMLRewriter()
					// Inject JS shim into <head>
					.on('head', {
						element(el) { el.prepend(jsShim, { html: true }); },
					})
					// Rewrite <a href>
					.on('a[href]', {
						element(el) {
							const href = el.getAttribute('href');
							if (href) el.setAttribute('href', resolveUrl(href));
						},
					})
					// Rewrite <link href> (CSS, icons, etc.)
					.on('link[href]', {
						element(el) {
							const href = el.getAttribute('href');
							if (href) el.setAttribute('href', resolveUrl(href));
						},
					})
					// Rewrite <script src>
					.on('script[src]', {
						element(el) {
							const src = el.getAttribute('src');
							if (src) el.setAttribute('src', resolveUrl(src));
						},
					})
					// Rewrite <img src> and <img srcset>
					.on('img[src]', {
						element(el) {
							const src = el.getAttribute('src');
							if (src) el.setAttribute('src', resolveUrl(src));
							const srcset = el.getAttribute('srcset');
							if (srcset) {
								const rewritten = srcset.split(',').map(entry => {
									const parts = entry.trim().split(/\s+/);
									parts[0] = resolveUrl(parts[0]);
									return parts.join(' ');
								}).join(', ');
								el.setAttribute('srcset', rewritten);
							}
						},
					})
					// Rewrite <source src/srcset>
					.on('source[src], source[srcset]', {
						element(el) {
							const src = el.getAttribute('src');
							if (src) el.setAttribute('src', resolveUrl(src));
							const srcset = el.getAttribute('srcset');
							if (srcset) {
								const rewritten = srcset.split(',').map(entry => {
									const parts = entry.trim().split(/\s+/);
									parts[0] = resolveUrl(parts[0]);
									return parts.join(' ');
								}).join(', ');
								el.setAttribute('srcset', rewritten);
							}
						},
					})
					// Rewrite <form action>
					.on('form[action]', {
						element(el) {
							const action = el.getAttribute('action');
							if (action) el.setAttribute('action', resolveUrl(action));
						},
					})
					// Rewrite <iframe src>
					.on('iframe[src]', {
						element(el) {
							const src = el.getAttribute('src');
							if (src) el.setAttribute('src', resolveUrl(src));
						},
					})
					// Rewrite <video src>, <audio src>
					.on('video[src], audio[src]', {
						element(el) {
							const src = el.getAttribute('src');
							if (src) el.setAttribute('src', resolveUrl(src));
						},
					})
					// Strip frame-busting headers via <meta>
					.on('meta[http-equiv]', {
						element(el) {
							const equiv = el.getAttribute('http-equiv')?.toLowerCase();
							if (equiv === 'content-security-policy' || equiv === 'x-frame-options') {
								el.remove();
							}
						},
					})
					// Rewrite <base href>
					.on('base[href]', {
						element(el) { el.remove(); },
					});

				const transformed = rewriter.transform(proxyRes);

				const h = new Headers();
				h.set('Content-Type', 'text/html; charset=utf-8');
				h.set('Access-Control-Allow-Origin', '*');
				// Remove frame-busting headers
				// (proxyRes headers are NOT forwarded — we build clean headers)

				return new Response(transformed.body, { headers: h });

			} catch (e: any) {
				return err('tunnel error: ' + e.message, 502);
			}
		}

		return err('not found', 404);
	},
};
