// _worker.js

// Utility to prune old daily stats
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}

async function handleRequest(request, env) {
  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');
  const meth = request.method;

  // ─────── ADMIN API ───────
  if (path.startsWith('api/')) {
    // Authentication
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // GET /api/list
    if (meth === 'GET' && path === 'api/list') {
      const list = await env.LINKS.list();
      const items = await Promise.all(
        list.keys
          .filter(k => /^[a-z0-9]{6}$/i.test(k.name))
          .map(async k => {
            const { metadata = {} } = await env.LINKS.getWithMetadata(k.name) || {};
            return {
              code: k.name,
              url: await env.LINKS.get(k.name),
              created: metadata.created || 0,
              creator: metadata.creator || null,
              expiresIn: metadata.exp ? metadata.exp - Date.now()/1000 : null
            };
          })
      );
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // GET /api/stats/:slug
    if (meth === 'GET' && /^api\/stats\/[a-z0-9]{6}$/i.test(path)) {
      const slug = path.split('/').pop();
      const clicks = parseInt(await env.STATS.get(slug) || '0', 10);
      const logs   = JSON.parse(await env.LOGS.get('log:' + slug) || '[]').slice(0,20);
      return new Response(JSON.stringify({ clicks, logs }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // GET /api/detail/:slug
    if (meth === 'GET' && /^api\/detail\/[a-z0-9]{6}$/i.test(path)) {
      const slug = path.split('/').pop();
      const total = parseInt(await env.STATS.get(slug) || '0', 10);
      const now   = Date.now();
      // last 30 days
      const byDay = {};
      for (let i = 0; i < 30; i++) {
        const d = new Date(now - i * 864e5).toISOString().slice(0,10).replace(/-/g,'');
        const n = parseInt(await env.STATS_DAY.get(`${d}:${slug}`) || '0', 10);
        if (n) byDay[d] = n;
      }
      // byHour if <24h old
      const raw = JSON.parse(await env.LOGS.get('log:' + slug) || '[]');
      const { metadata = {} } = await env.LINKS.getWithMetadata(slug) || {};
      const created = metadata.created || now;
      const byHour = {};
      if (now - created < 86_400_000) {
        raw.forEach(l => {
          const h = new Date(l.t).getHours().toString().padStart(2,'0');
          byHour[h] = (byHour[h]||0) + 1;
        });
      }
      // heat points
      const points = raw.filter(l=>l.lat!=null).map(l=>[l.lat,l.lon]);
      return new Response(JSON.stringify({ total, byDay, byHour, points, logs: raw.slice(0,100) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // DELETE /api/delete/:slug
    if (meth === 'DELETE' && /^api\/delete\/[a-z0-9]{6}$/i.test(path)) {
      const slug = path.split('/').pop();
      await Promise.all([
        env.LINKS.delete(slug),
        env.STATS.delete(slug),
        env.LOGS.delete('log:' + slug),
        pruneDaily(env.STATS_DAY, slug)
      ]);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─────── Create link (POST /) ───────
  if (meth === 'POST' && path === '') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid json' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const { code, url: longUrl, ttl } = body;
    if (!code || !/^https?:\/\//i.test(longUrl)) {
      return new Response(JSON.stringify({ error: 'bad payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await Promise.all([
      env.STATS.delete(code),
      env.LOGS.delete('log:' + code),
      pruneDaily(env.STATS_DAY, code)
    ]);
    const ttlSec = Math.min(Math.max(ttl ?? 0, 900), 2_592_000);
    const meta = {
      created: Date.now(),
      creator: {
        ip: request.headers.get('CF-Connecting-IP'),
        loc: request.cf?.country || '??'
      },
      exp: Date.now()/1000 + ttlSec
    };
    await env.LINKS.put(code, longUrl, {
      expirationTtl: ttlSec,
      metadata: meta
    });
    return new Response(JSON.stringify({ ok: true, code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─────── Redirect /<slug> (GET) ───────
  if (meth === 'GET' && /^[a-z0-9]{6}$/i.test(path)) {
    const dest = await env.LINKS.get(path);
    if (!dest) {
      await Promise.all([
        env.STATS.delete(path),
        env.LOGS.delete('log:' + path),
        pruneDaily(env.STATS_DAY, path)
      ]);
      return new Response('Not found', { status: 404 });
    }
    // increment totals
    const tot      = parseInt(await env.STATS.get(path) || '0',10) + 1;
    env.STATS.put(path, tot.toString());
    // increment daily
    const dayKey  = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + path;
    const daily   = parseInt(await env.STATS_DAY.get(dayKey) || '0',10) + 1;
    env.STATS_DAY.put(dayKey, daily.toString());
    // log geo
    let { latitude:lat=null, longitude:lon=null } = request.cf || {};
    if (lat==null||lon==null) {
      const c = CENTROID[request.cf?.country?.toUpperCase()];
      if (c) [lat,lon] = c;
    }
    const logsArr = JSON.parse(await env.LOGS.get('log:' + path) || '[]');
    logsArr.unshift({ t: Date.now(), ip: request.headers.get('CF-Connecting-IP'), loc: request.cf?.country, lat, lon });
    logsArr.length = Math.min(logsArr.length, 300);
    env.LOGS.put('log:' + path, JSON.stringify(logsArr));
    return Response.redirect(dest, 302);
  }

  // ─────── Static assets (GET) ───────
  if (meth === 'GET') {
    return env.ASSETS.fetch(request);
  }

  // ─────── Fallback ───────
  return new Response('Method Not Allowed', { status: 405 });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
