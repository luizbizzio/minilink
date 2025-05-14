// functions/[slug].js

const CORS = {
  'Access-Control-Allow-Origin': '*'
};

export async function onRequestGet({ request, params, env }) {
  const url  = new URL(request.url);
  const path = url.pathname;       // ex: "/admin", "/admin/app.js", "/99f934"
  const slug = params.slug;        // só o segmento após a "/" 

  // ── 1) Se for /admin ou /admin/qualquer-coisa, serve estático ──
  if (path === '/admin' || path.startsWith('/admin/')) {
    return fetch(request);
  }

  // ── 2) Agora sim, valida slug de 6 chars ──
  if (!/^[a-z0-9]{6}$/i.test(slug)) {
    return new Response('Not found', {
      status: 404,
      headers: CORS
    });
  }

  // ── 3) Busca destino no KV ──
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    // (opcional) limpa estatísticas órfãs
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', {
      status: 404,
      headers: CORS
    });
  }

  // ── 4) Atualiza contadores ──
  const tot = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
  env.STATS.put(slug, tot.toString());

  const today    = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const dailyKey = `${today}:${slug}`;
  const daily    = parseInt(await env.STATS_DAY.get(dailyKey) || '0', 10) + 1;
  env.STATS_DAY.put(dailyKey, daily.toString());

  // ── 5) (Opcional) Log de localização ──
  const ip  = request.headers.get('CF-Connecting-IP');
  const loc = request.cf?.country || '??';
  const raw = await env.LOGS.get('log:' + slug) || '[]';
  const arr = JSON.parse(raw);
  arr.unshift({ t: Date.now(), ip, loc });
  arr.length = Math.min(arr.length, 300);
  await env.LOGS.put('log:' + slug, JSON.stringify(arr));

  // ── 6) Redireciona de verdade ──
  return Response.redirect(dest, 302);
}

// Helper para limpar chaves diárias
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
