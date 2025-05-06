// _worker.js

const CENTROID = {
  US: [37, -95], BR: [-14, -52], FR: [46, 2],
  GB: [54, -2], DE: [51, 10], IN: [22, 79]
};

async function onRequest({ request, env }) {
  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');
  const meth = request.method;

  // ─────── ADMIN API ───────
  if (path.startsWith('api/')) {
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN) {
      return json({ error: 'Forbidden' }, 403);
    }
    // GET /api/list
    if (meth === 'GET' && path === 'api/list') {
      const list = await env.LINKS.list();
      const items = await Promise.all(
        list.keys
          .filter(k => /^[a-z0-9]{6}$/i.test(k.name))
          .map(async k => {
            const meta = (await env.LINKS.getWithMetadata(k.name)).metadata || {};
            return {
              code: k.name,
              url: await env.LINKS.get(k.name),
              created: meta.created || 0,
              creator: meta.creator || null,
              expiresIn: meta.exp
                ? meta.exp - Date.now() / 1000
                : null
            };
          })
      );
      return json(items);
    }
    // GET /api/stats/:slug
    if (meth === 'GET' && /^api\/stats\/[a-z0-9]{6}$/i.test(path)) {
      const slug    = path.split('/').pop();
      const creator = (await env.LINKS.getWithMetadata(slug))
                        .metadata?.creator || null;
      return json({
        clicks: parseInt(await env.STATS.get(slug) || '0', 10),
        logs:   safeJson(await env.LOGS.get('log:' + slug)).slice(0, 20),
        creator
      });
    }
    // GET /api/detail/:slug
    if (meth === 'GET' && /^api\/detail\/[a-z0-9]{6}$/i.test(path)) {
      // ... seu código de detail aqui ...
      return json({ /* ... */ });
    }
    // DELETE /api/delete/:slug
    if (meth === 'DELETE' && /^api\/delete\/[a-z0-9]{6}$/i.test(path)) {
      // ... seu código de delete aqui ...
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  }

  // ─────── Create link (POST /) ───────
  if (meth === 'POST' && path === '') {
    try {
      const { code, url: longUrl, ttl } = await request.json();
      if (!code || !longUrl || !/^https?:\/\//i.test(longUrl)) {
        return json({ error: 'bad payload' }, 400);
      }
      // limpa dados antigos
      await Promise.all([
        env.STATS.delete(code),
        env.LOGS.delete('log:' + code),
        pruneDaily(env.STATS_DAY, code)
      ]);
      const ttlSec = Math.min(Math.max(ttl ?? 0, 900), 2_592_000);
      const meta = {
        created: Date.now(),
        creator: {
          ip:  request.headers.get('CF-Connecting-IP'),
          loc: request.cf?.country || '??'
        },
        exp: Date.now() / 1000 + ttlSec
      };
      const opts = ttlSec
        ? { expirationTtl: ttlSec, metadata: meta }
        : { metadata: meta };
      await env.LINKS.put(code, longUrl, opts);
      return json({ ok: true, code });
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
  }

  // ─────── Redirect /<slug> (GET) ───────
  if (meth === 'GET' && /^[a-z0-9]{6}$/i.test(path)) {
    const dest = await env.LINKS.get(path);
    if (!dest) {
      // cleanup expirados
      await Promise.all([
        env.STATS.delete(path),
        env.LOGS.delete('log:' + path),
        pruneDaily(env.STATS_DAY, path)
      ]);
      return new Response('Not found', { status: 404 });
    }
    // incrementar stats, logs, etc...
    return Response.redirect(dest, 302);
  }

  // ─────── Static assets (GET only) ───────
  if (meth === 'GET') {
    return env.ASSETS.fetch(request);
  }

  // ─────── Fallback ───────
  return new Response('Method Not Allowed', { status: 405 });
}

// Exporta o handler para o Wrangler
export default {
  async fetch(request, env) {
    return onRequest({ request, env });
  }
};

// ────── Helpers ──────

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

const safeJson = t => {
  if (!t || t === 'null') return [];
  try { return JSON.parse(t); } catch { return []; }
};

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
