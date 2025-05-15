// functions/_middleware.js

export async function onRequest(context) {
  const { request, env, next } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  // CORS headers
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors }
    });

  // 1) Preflight CORS
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 2) Redirect "/admin" → "/admin/" so Pages will serve admin/index.html
  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }

  // 3) Serve static HTML for "/" and anything under "/admin/"
  if (path === '/' || path.startsWith('/admin/')) {
    return await next();
  }

  // 4) Create new short link: POST "/"
  if (method === 'POST' && path === '/') {
    try {
      const { code, url: longUrl, ttl } = await request.json();
      if (!code || !/^https?:\/\//i.test(longUrl)) {
        return json({ error: 'bad payload' }, 400);
      }

      // Compute expiration metadata, but do NOT clear stats/logs here
      const ttlSec = Math.min(Math.max(ttl || 0, 900), 2_592_000);
      const exp    = Date.now() / 1000 + ttlSec;
      const meta   = {
        created: Date.now(),
        exp,
        creator: {
          ip:  request.headers.get('CF-Connecting-IP'),
          loc: request.cf?.country || '??'
        }
      };

      // Store without expirationTtl so that we keep stats/logs
      await env.LINKS.put(code, longUrl, { metadata: meta });
      return json({ ok: true, code });

    } catch {
      return json({ error: 'invalid json' }, 400);
    }
  }

  // 5) Admin API: GET "/api/list" — includes total clicks + last 3 hits + expiresIn
  if (method === 'GET' && path === '/api/list') {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const { keys } = await env.LINKS.list();
    const items = await Promise.all(
      keys
        .filter(k => /^[a-z0-9]{6}$/i.test(k.name))
        .map(async k => {
          const code = k.name;
          const url  = await env.LINKS.get(code);
          const { metadata = {} } = await env.LINKS.getWithMetadata(code) || {};
          const created   = metadata.created || 0;
          const exp       = metadata.exp || 0;
          const expiresIn = Math.floor(exp - Date.now()/1000);

          const clicks = parseInt(await env.STATS.get(code) || '0', 10);
          const rawLogs = JSON.parse(await env.LOGS.get('log:' + code) || '[]');
          const logs    = rawLogs.slice(0, 3);

          return {
            code,
            url,
            clicks,
            created,
            creator:   metadata.creator || null,
            expiresIn,
            logs
          };
        })
    );
    return json(items);
  }

  // 6) Admin API: GET "/api/stats/:slug"
  if (method === 'GET' && /^\/api\/stats\/[a-z0-9]{6}$/i.test(path)) {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const slug   = path.split('/').pop();
    const clicks = parseInt(await env.STATS.get(slug) || '0', 10);
    const logs   = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');
    return json({ clicks, logs });
  }

  // 7) Admin API: GET "/api/detail/:slug"
  if (method === 'GET' && /^\/api\/detail\/[a-z0-9]{6}$/i.test(path)) {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const slug        = path.split('/').pop();
    const clicksTotal = parseInt(await env.STATS.get(slug) || '0', 10);
    const now         = Date.now();
    const byDay       = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(now - i * 864e5)
        .toISOString().slice(0, 10).replace(/-/g, '');
      const n = parseInt(await env.STATS_DAY.get(`${d}:${slug}`) || '0', 10);
      if (n) byDay[d] = n;
    }
    const rawLogs = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');
    const points  = rawLogs.filter(l => l.lat != null).map(l => [l.lat, l.lon]);
    const byHour  = {};
    const created = (await env.LINKS.getWithMetadata(slug)).metadata?.created || now;
    if (now - created < 864e5) {
      rawLogs.forEach(l => {
        const h = new Date(l.t).getHours().toString().padStart(2, '0');
        byHour[h] = (byHour[h] || 0) + 1;
      });
    }
    return json({ clicksTotal, byDay, byHour, points, logs: rawLogs.slice(0, 100) });
  }

  // 8) Admin API: DELETE "/api/delete/:slug"
  if (method === 'DELETE' && /^\/api\/delete\/[a-z0-9]{6}$/i.test(path)) {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const slug = path.split('/').pop();
    await Promise.all([
      env.LINKS.delete(slug),
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return json({ ok: true });
  }

  // 9) Redirect slug: GET "/XXXXXX" with expiration check
  if (method === 'GET' && /^\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.slice(1);
    const { value: dest, metadata = {} } = await env.LINKS.getWithMetadata(slug) || {};
    if (!dest) {
      return new Response('Not found', { status: 404 });
    }
    const nowSec = Date.now() / 1000;
    if (metadata.exp && nowSec > metadata.exp) {
      // expired: do not delete, just 404
      return new Response('Not found', { status: 404 });
    }

    // increment total clicks
    const total = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
    await env.STATS.put(slug, total.toString());

    // increment daily clicks
    const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
    const daily  = parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1;
    await env.STATS_DAY.put(dayKey, daily.toString());

    // capture IP/country and lat/lon (with GEO fallback)
    const ip  = request.headers.get('CF-Connecting-IP');
    const loc = request.cf?.country || '??';
    let lat = request.cf?.latitude ?? null;
    let lon = request.cf?.longitude ?? null;
    if (lat == null || lon == null) {
      const geo = await env.GEO.get(loc);
      if (geo) {
        try { [lat, lon] = JSON.parse(geo); } catch {}
      }
    }
    const raw = await env.LOGS.get('log:' + slug) || '[]';
    const arr = JSON.parse(raw);
    arr.unshift({ t: Date.now(), ip, loc, lat, lon });
    arr.length = Math.min(arr.length, 300);
    await env.LOGS.put('log:' + slug, JSON.stringify(arr));

    return Response.redirect(dest, 302);
  }

  // fallback 404
  return new Response('Not found', { status: 404 });
}

// Helper to prune old daily keys
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
