// functions/[[...slug]].js

export async function onRequest({ request, env, next }) {
  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');
  const meth = request.method;

  // ───── Criar link (POST /) ─────
  if (meth === 'POST' && path === '') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error:'invalid json' }), {
        status:400, headers:{ 'Content-Type':'application/json' }
      });
    }
    const { code, url: longUrl, ttl } = body;
    if (!code || !/^https?:\/\//i.test(longUrl)) {
      return new Response(JSON.stringify({ error:'bad payload' }), {
        status:400, headers:{ 'Content-Type':'application/json' }
      });
    }
    // limpa dados antigos
    await Promise.all([
      env.STATS.delete(code),
      env.LOGS.delete('log:' + code),
      pruneDaily(env.STATS_DAY, code)
    ]);
    // grava no KV com TTL
    const ttlSec = Math.min(Math.max(ttl ?? 0, 900), 2_592_000);
    await env.LINKS.put(code, longUrl, {
      expirationTtl: ttlSec,
      metadata: { created: Date.now() }
    });
    return new Response(JSON.stringify({ ok:true, code }), {
      status:200, headers:{ 'Content-Type':'application/json' }
    });
  }

  // ───── Redirect /<slug> (GET) ─────
  if (meth === 'GET' && /^[a-z0-9]{6}$/i.test(path)) {
    const dest = await env.LINKS.get(path);
    if (!dest) {
      // cleanup expirados
      await Promise.all([
        env.STATS.delete(path),
        env.LOGS.delete('log:' + path),
        pruneDaily(env.STATS_DAY, path)
      ]);
      return new Response('Not found', { status:404 });
    }
    // incrementa totais
    const total = parseInt(await env.STATS.get(path) || '0', 10) + 1;
    env.STATS.put(path, total.toString());
    // incrementa por dia
    const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + path;
    const dayCnt = parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1;
    env.STATS_DAY.put(dayKey, dayCnt.toString());
    // log geo
    let { latitude:lat = null, longitude:lon = null } = request.cf || {};
    if (lat == null || lon == null) {
      const CENTROID = { US:[37,-95], BR:[-14,-52], FR:[46,2], GB:[54,-2], DE:[51,10], IN:[22,79] };
      const c = CENTROID[request.cf?.country];
      if (c) [lat,lon] = c;
    }
    const logsArr = JSON.parse(await env.LOGS.get('log:' + path) || '[]');
    logsArr.unshift({
      t: Date.now(),
      ip: request.headers.get('CF-Connecting-IP'),
      loc: request.cf?.country,
      lat, lon
    });
    logsArr.length = Math.min(logsArr.length, 300);
    env.LOGS.put('log:' + path, JSON.stringify(logsArr));

    return Response.redirect(dest, 302);
  }

  // ───── Tudo o resto: serve estático ─────
  return next();
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix:'', limit:1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':' + slug)).map(k => ns.delete(k.name))
  );
}
