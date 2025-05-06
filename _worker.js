// _worker.js

const CENTROIDS = {
  US: [37, -95], BR: [-14, -52], FR: [46, 2],
  GB: [54, -2], DE: [51, 10], IN: [22, 79]
};

// Helper para retornar JSON
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}

export default {
  async fetch(request, env) {
    const url   = new URL(request.url);
    const path  = url.pathname;
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(p=>p);
    const method = request.method;

    // 1) API Admin (todas as rotas /api/...)
    if (parts[0] === 'api') {
      return handleApi(request, env, parts);
    }

    // 2) Criar link (POST /)
    if (method === 'POST' && (path === '/' || path === '')) {
      return handleCreate(request, env);
    }

    // 3) Redirect de slug (GET /<6 chars>)
    if (
      method === 'GET' &&
      parts.length === 1 &&
      /^[a-z0-9]{6}$/i.test(parts[0])
    ) {
      return handleRedirect(request, env, parts[0]);
    }

    // 4) Rota /admin serve public/admin/index.html
    if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
      const base = new URL(request.url);
      base.pathname = '/admin/index.html';
      return fetchStatic(base.toString(), request, env);
    }

    // 5) Rota raiz / serve public/index.html
    if (method === 'GET' && (path === '/' || path === '')) {
      const base = new URL(request.url);
      base.pathname = '/index.html';
      return fetchStatic(base.toString(), request, env);
    }

    // 6) Qualquer outro GET cai direto no static (CSS, JS, imagens, etc)
    if (method === 'GET') {
      return fetchStatic(request.url, request, env);
    }

    // 7) Qualquer outro método: não permitido
    return new Response('Method Not Allowed', { status: 405 });
  }
};

// Função para buscar no binding correto
function fetchStatic(url, request, env) {
  // tenta ASSETS, se não existir, cai em __STATIC_CONTENT
  const bucket = env.ASSETS ?? env.__STATIC_CONTENT;
  if (!bucket || typeof bucket.fetch !== 'function') {
    return new Response('Static binding not found', { status: 500 });
  }
  return bucket.fetch(new Request(url, request));
}

// Implementação de POST /
async function handleCreate(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid json' }, 400); }

  const { code, url: longUrl, ttl } = body;
  if (!code || !/^https?:\/\//i.test(longUrl)) {
    return json({ error: 'bad payload' }, 400);
  }

  await Promise.all([
    env.STATS.delete(code),
    env.LOGS.delete('log:' + code),
    pruneDaily(env.STATS_DAY, code)
  ]);

  const ttlSec = Math.min(Math.max(ttl || 0, 900), 2_592_000);
  await env.LINKS.put(code, longUrl, {
    expirationTtl: ttlSec,
    metadata: { created: Date.now() }
  });

  return json({ ok: true, code });
}

// Implementação de GET /<slug>
async function handleRedirect(request, env, slug) {
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status: 404 });
  }

  // incrementa tot e diário
  const total = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
  env.STATS.put(slug, total.toString());

  const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
  const dayCnt = parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1;
  env.STATS_DAY.put(dayKey, dayCnt.toString());

  // log geo
  let { latitude: lat = null, longitude: lon = null } = request.cf || {};
  if (lat == null || lon == null) {
    const c = CENTROIDS[request.cf?.country];
    if (c) [lat, lon] = c;
  }
  const logsKey = 'log:' + slug;
  const arr = JSON.parse(await env.LOGS.get(logsKey) || '[]');
  arr.unshift({
    t: Date.now(),
    ip: request.headers.get('CF-Connecting-IP'),
    loc: request.cf?.country,
    lat, lon
  });
  arr.length = Math.min(arr.length, 300);
  env.LOGS.put(logsKey, JSON.stringify(arr));

  return Response.redirect(dest, 302);
}

// Implementação de /api/...
async function handleApi(request, env, parts) {
  const token = request.headers.get('X-Admin-Token');
  if (token !== env.ADMIN_TOKEN) {
    return json({ error: 'Forbidden' }, 403);
  }

  const action = parts[1], slug = parts[2];

  // GET /api/list
  if (request.method === 'GET' && action === 'list') {
    const keys = (await env.LINKS.list()).keys.filter(k=>/^[a-z0-9]{6}$/i.test(k.name));
    const items = await Promise.all(keys.map(async k=>{
      const { metadata = {} } = (await env.LINKS.getWithMetadata(k.name)) || {};
      return {
        code: k.name,
        url: await env.LINKS.get(k.name),
        created: metadata.created || 0,
        expiresIn: metadata.exp ? metadata.exp - Date.now()/1000 : null
      };
    }));
    return json(items);
  }

  // GET /api/stats/:slug
  if (request.method === 'GET' && action === 'stats' && slug) {
    const clicks = parseInt(await env.STATS.get(slug) || '0', 10);
    const logs   = JSON.parse(await env.LOGS.get('log:' + slug) || '[]').slice(0,20);
    return json({ clicks, logs });
  }

  // GET /api/detail/:slug
  if (request.method === 'GET' && action === 'detail' && slug) {
    // ... sua lógica de detail ...
    return json({ /* ... */ });
  }

  // DELETE /api/delete/:slug
  if (request.method === 'DELETE' && action === 'delete' && slug) {
    await Promise.all([
      env.LINKS.delete(slug),
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return json({ ok: true });
  }

  return new Response('Not found', { status: 404 });
}
