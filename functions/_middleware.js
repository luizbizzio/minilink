// functions/_middleware.js
export async function onRequest(context) {
  const { request, env, next } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  /* util --------------------------------------------------------------- */
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
  };
  const json = (d, s = 200) =>
    new Response(JSON.stringify(d), {
      status: s,
      headers: { 'Content-Type': 'application/json', ...cors }
    });

  if (method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  /* arquivos estáticos / painel --------------------------------------- */
  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }
  if (path === '/' || path.startsWith('/admin/'))
    return await next();

  /* ---------- POST /  (criar link) ----------------------------------- */
  if (method === 'POST' && path === '/') {
    try {
      let { code, url: longUrl, ttl = 0 } = await request.json();
      ttl = Number(ttl);                         // '0' → 0

      if (!code || !/^https?:\/\//i.test(longUrl))
        return json({ error: 'bad payload' }, 400);

      const ttlSec = ttl === 0 ? 0
                   : Math.min(Math.max(ttl, 900), 2_592_000);
      const exp    = ttlSec === 0 ? 0             // 0 = ilimitado
                   : Math.floor(Date.now() / 1000) + ttlSec;

      /* NÃO usamos expirationTtl */
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

  /* ---------- GET /api/list ------------------------------------------ */
  if (method === 'GET' && path === '/api/list') {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const { keys } = await env.LINKS.list();
    const items = (await Promise.all(
      keys.filter(k => /^[a-z0-9]{6}$/i.test(k.name)).map(async k => {
        const code = k.name;
        const obj  = await env.LINKS.getWithMetadata(code);
        if (!obj || obj.value == null) return null;   // chave removida à força

        const meta      = obj.metadata ?? {};
        const exp       = meta.exp ?? 0;
        const expiresIn = Math.floor(exp - Date.now() / 1000); // 0 = ∞

        return {
          code,
          url       : obj.value,
          clicks    : parseInt(await env.STATS.get(code) || '0', 10),
          created   : meta.created ?? 0,
          creator   : meta.creator ?? null,
          expiresIn : meta.deleted ? -1 : expiresIn,   // -1 = deleted
          expired   : meta.deleted || (exp !== 0 && expiresIn <= 0),
          logs      : (JSON.parse(await env.LOGS.get('log:' + code) || '[]'))
                        .slice(0, 3)
        };
      })
    )).filter(Boolean);

    items.sort((a, b) => b.created - a.created);       // mais novos primeiro
    return json(items);
  }

  /* ---------- GET /api/detail/:slug ---------------------------------- */
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

    const byDay = {};
    for (let i = 0; i < 30; i++) {
      const dayId = new Date(now - i * 864e5)
        .toISOString().slice(0,10).replace(/-/g,'');
      const cnt = parseInt(await env.STATS_DAY.get(`${dayId}:${slug}`) || '0', 10);
      if (cnt) byDay[dayId] = cnt;
    }

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
      logs: rawLogs.slice(0, 100)
    });
  }

  /* ---------- DELETE /api/delete/:slug (marca deleted) --------------- */
  if (method === 'DELETE' && /^\/api\/delete\/[a-z0-9]{6}$/i.test(path)) {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN)
      return new Response('Forbidden', { status: 403 });

    const slug = path.split('/').pop();
    const obj  = await env.LINKS.getWithMetadata(slug);
    if (!obj) return json({ error: 'not found' }, 404);

    const meta = { ...(obj.metadata ?? {}), exp: 1, deleted: true };
    await env.LINKS.put(slug, obj.value, { metadata: meta });
    return json({ ok: true });
  }

  /* ---------- redirect /slug  ---------------------------------------- */
  if (method === 'GET' && /^\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.slice(1);
    const obj  = await env.LINKS.getWithMetadata(slug);
    if (!obj || obj.value == null)
      return new Response('Not found', { status: 404 });

    const meta   = obj.metadata ?? {};
    const nowSec = Math.floor(Date.now() / 1000);
    if (meta.deleted || (meta.exp && meta.exp < nowSec))
      return new Response('Link expired', { status: 410 });

    /* stats totais */
    await env.STATS.put(
      slug,
      (parseInt(await env.STATS.get(slug) || '0', 10) + 1).toString()
    );

    /* stats diários */
    const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'')+':'+slug;
    await env.STATS_DAY.put(
      dayKey,
      (parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1).toString()
    );

    /* logs */
    const ip  = request.headers.get('CF-Connecting-IP');
    const loc = request.cf?.country || '??';
    let lat   = request.cf?.latitude ?? null,
        lon   = request.cf?.longitude ?? null;
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

  /* fallback */
  return new Response('Not found', { status: 404 });
}

/* helper opcional: limpa stats diários de um slug (não usado pelo painel) */
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ limit: 1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':' + slug))
        .map(k => ns.delete(k.name))
  );
}
