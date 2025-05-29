// functions/_middleware.js
export async function onRequest (context) {
  const { request, env, next } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  /* ---------- util ---------- */

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

  /* ---------- CORS pre-flight ---------- */

  if (method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  /* ---------- static / admin ---------- */

  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }
  if (path === '/' || path.startsWith('/admin/'))
    return await next();

  /* ---------- create short link ---------- */

  if (method === 'POST' && path === '/') {
    try {
      const { code, url: longUrl, ttl = 0 } = await request.json();
      if (!code || !/^https?:\/\//i.test(longUrl))
        return json({ error: 'bad payload' }, 400);

      // ttl = 0   → sem expiração
      // ttl  > 0  → mínimo 15 min e máx 30 dias
      const ttlSec = ttl === 0 ? 0
                   : Math.min(Math.max(ttl, 900), 2_592_000);
      const exp    = ttlSec === 0 ? 0 : Math.floor(Date.now() / 1000) + ttlSec;

      await env.LINKS.put(code, longUrl, {
        metadata: {
          created: Date.now(),
          exp,
          creator: {
            ip : request.headers.get('CF-Connecting-IP'),
            loc: request.cf?.country || '??'
          }
        }
      });
      return json({ ok: true, code });

    } catch {
      return json({ error: 'invalid json' }, 400);
    }
  }

  /* ---------- admin: list ---------- */

  if (method === 'GET' && path === '/api/list') {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const { keys } = await env.LINKS.list();

    const items = (await Promise.all(
      keys
        .filter(k => /^[a-z0-9]{6}$/i.test(k.name))
        .map(async k => {
          const code = k.name;
          const obj  = await env.LINKS.getWithMetadata(code);
          if (!obj || obj.value == null) return null;          // já foi apagado

          const meta       = obj.metadata ?? {};
          const created    = meta.created ?? 0;
          const exp        = meta.exp ?? 0;
          const expiresIn  = exp === 0 ? null
                             : Math.floor(exp - Date.now() / 1000);
          const expired    = expiresIn !== null && expiresIn <= 0;

          return {
            code,
            url       : obj.value,
            clicks    : parseInt(await env.STATS.get(code) || '0', 10),
            created,
            creator   : meta.creator ?? null,
            expiresIn,
            expired,
            logs      : (JSON.parse(await env.LOGS.get('log:' + code) || '[]'))
                          .slice(0, 3)
          };
        })
    )).filter(Boolean);                                        // remove nulls

    return json(items);
  }

  /* ---------- admin: stats resumo ---------- */

  if (method === 'GET' && /^\/api\/stats\/[a-z0-9]{6}$/i.test(path)) {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const slug   = path.split('/').pop();
    const clicks = parseInt(await env.STATS.get(slug) || '0', 10);
    const logs   = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');
    return json({ clicks, logs });
  }

  /* ---------- admin: detail ---------- */

  if (method === 'GET' && /^\/api\/detail\/[a-z0-9]{6}$/i.test(path)) {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const slug  = path.split('/').pop();
    const now   = Date.now();
    const obj   = await env.LINKS.getWithMetadata(slug);
    if (!obj) return json({ error: 'not found' }, 404);

    const created     = obj.metadata?.created ?? now;
    const clicksTotal = parseInt(await env.STATS.get(slug) || '0', 10);
    const rawLogs     = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');

    /* byDay (últimos 30 dias) */
    const byDay = {};
    for (let i = 0; i < 30; i++) {
      const dayId = new Date(now - i * 864e5)
        .toISOString().slice(0,10).replace(/-/g,'');
      const cnt = parseInt(await env.STATS_DAY.get(`${dayId}:${slug}`) || '0', 10);
      if (cnt) byDay[dayId] = cnt;
    }

    /* byHour se criado hoje */
    const byHour = {};
    if (now - created < 864e5) {
      rawLogs.forEach(l => {
        const h = new Date(l.t).getHours().toString().padStart(2,'0');
        byHour[h] = (byHour[h] || 0) + 1;
      });
    }

    const points = rawLogs
      .filter(l => l.lat != null && l.lon != null)
      .map(l => [l.lat, l.lon]);

    return json({
      clicksTotal,
      byDay,
      byHour,
      points,
      logs : rawLogs.slice(0,100)
    });
  }

  /* ---------- admin: delete ---------- */

  if (method === 'DELETE' && /^\/api\/delete\/[a-z0-9]{6}$/i.test(path)) {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const slug = path.split('/').pop();
    await Promise.all([
      env.LINKS.delete(slug),
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return json({ ok: true });
  }

  /* ---------- redirect slug ---------- */

  if (method === 'GET' && /^\/[a-z0-9]{6}$/i.test(path)) {
    const slug    = path.slice(1);
    const obj     = await env.LINKS.getWithMetadata(slug);
    if (!obj || obj.value == null)
      return new Response('Not found', { status: 404 });

    const meta    = obj.metadata ?? {};
    const nowSec  = Math.floor(Date.now() / 1000);
    if (meta.exp && meta.exp < nowSec)
      return new Response('Link expired', { status: 410 });

    /* stats & logs */
    await env.STATS.put(slug,
      (parseInt(await env.STATS.get(slug) || '0',10)+1).toString());

    const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
    await env.STATS_DAY.put(dayKey,
      (parseInt(await env.STATS_DAY.get(dayKey) || '0',10)+1).toString());

    const ip  = request.headers.get('CF-Connecting-IP');
    const loc = request.cf?.country || '??';
    let lat   = request.cf?.latitude ?? null;
    let lon   = request.cf?.longitude ?? null;
    if (lat == null || lon == null) {
      const geo = await env.GEO.get(loc);
      if (geo) try { [lat, lon] = JSON.parse(geo); } catch {}
    }

    const raw = await env.LOGS.get('log:' + slug) || '[]';
    const arr = JSON.parse(raw);
    arr.unshift({ t: Date.now(), ip, loc, lat, lon });
    arr.length = Math.min(arr.length, 300);
    await env.LOGS.put('log:' + slug, JSON.stringify(arr));

    return Response.redirect(obj.value, 302);
  }

  /* ---------- fallback ---------- */
  return new Response('Not found', { status: 404 });
}

/* helper ----------------------------------------------------------------- */
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ limit: 1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':' + slug))
        .map(k => ns.delete(k.name))
  );
}
