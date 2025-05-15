// functions/_middleware.js

export async function onRequest(context) {
  const { request, env, next } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  // CORS
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

  // 1) Preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 2) /admin → /admin/
  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }

  // 3) static "/" e "/admin/*"
  if (path === '/' || path.startsWith('/admin/')) {
    return await next();
  }

  // 4) Criar link
  if (method === 'POST' && path === '/') {
    try {
      const { code, url: longUrl, ttl } = await request.json();
      if (!code || !/^https?:\/\//i.test(longUrl)) {
        return json({ error: 'bad payload' }, 400);
      }
      // limpa estatísticas antigas (se houver)
      await Promise.all([
        env.STATS.delete(code),
        env.LOGS.delete('log:' + code),
        pruneDaily(env.STATS_DAY, code)
      ]);

      // TTL entre 900s e 2.592.000s
      const ttlSec = Math.min(Math.max(ttl || 0, 900), 2_592_000);
      const exp    = Date.now()/1000 + ttlSec;
      const meta   = {
        created: Date.now(),
        exp,
        creator: {
          ip:  request.headers.get('CF-Connecting-IP'),
          loc: request.cf?.country || '??'
        }
      };

      // grava SEM expirationTtl
      await env.LINKS.put(code, longUrl, { metadata: meta });
      return json({ ok: true, code });
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
  }

  // 5) GET /api/list — inclui clicks + last 3 hits + expiresIn
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
            code, url, clicks,
            created, creator: metadata.creator||null,
            expiresIn, logs
          };
        })
    );
    return json(items);
  }

  // 6) GET /api/stats/:slug
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

  // 7) GET /api/detail/:slug
  if (method === 'GET' && /^\/api\/detail\/[a-z0-9]{6}$/i.test(path)) {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const slug = path.split('/').pop();
    const clicksTotal = parseInt(await env.STATS.get(slug) || '0', 10);
    // … calcula byDay, byHour, points, etc …
    // (igual ao código anterior)
    const rawLogs = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');
    return json({ clicksTotal, byDay, byHour, points, logs: rawLogs.slice(0, 100) });
  }

  // 8) DELETE /api/delete/:slug
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

  // 9) Redirect slug — só retorna 302 se não expirado
  if (method === 'GET' && /^\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.slice(1);
    const { value: dest, metadata = {} } = await env.LINKS.getWithMetadata(slug) || {};
    if (!dest) {
      return new Response('Not found', { status: 404 });
    }

    // checa expiração
    const now = Date.now()/1000;
    if (metadata.exp && now > metadata.exp) {
      // expirou: não apaga do KV, apenas 404
      return new Response('Not found', { status: 404 });
    }

    // grava stats e logs (await)
    const total = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
    await env.STATS.put(slug, total.toString());

    const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
    const daily  = parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1;
    await env.STATS_DAY.put(dayKey, daily.toString());

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
    arr.unshift({ t:Date.now(), ip, loc, lat, lon });
    arr.length = Math.min(arr.length, 300);
    await env.LOGS.put('log:' + slug, JSON.stringify(arr));

    return Response.redirect(dest, 302);
  }

  // fallback 404
  return new Response('Not found', { status: 404 });
}

// Helper
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':' + slug)).map(k => ns.delete(k.name))
  );
}
