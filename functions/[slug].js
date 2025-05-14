// functions/[slug].js
const cors = {
  'Access-Control-Allow-Origin': '*'
};

export async function onRequestGet({ params, env, request }) {
  const url  = new URL(request.url);
  const slug = params.slug;  // ex: "admin" ou "99f934"

  // 1) Se for /admin, deixa o Pages servir public/admin/index.html
  if (slug === 'admin') {
    return fetch(request);
  }

  // 2) Agora sim, só trata slugs válidos de 6 chars
  if (!/^[a-z0-9]{6}$/i.test(slug)) {
    return new Response('Not found', { status: 404, headers: cors });
  }

  // 3) Busca destino no KV
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    // opcional: limpeza de stats órfãs
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status: 404, headers: cors });
  }

  // 4) Incrementa contador total
  const total = (parseInt(await env.STATS.get(slug) || '0', 10) + 1).toString();
  env.STATS.put(slug, total);

  // 5) Incrementa estatística diária
  const today    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dailyKey = `${today}:${slug}`;
  const daily    = (parseInt(await env.STATS_DAY.get(dailyKey) || '0', 10) + 1).toString();
  env.STATS_DAY.put(dailyKey, daily);

  // 6) Log de localização (opcional)
  const ip  = request.headers.get('CF-Connecting-IP');
  const loc = request.cf?.country || '??';
  const raw = await env.LOGS.get('log:' + slug);
  const arr = raw && raw !== 'null' ? JSON.parse(raw) : [];
  arr.unshift({ t: Date.now(), ip, loc });
  arr.length = Math.min(arr.length, 300);
  await env.LOGS.put('log:' + slug, JSON.stringify(arr));

  // 7) Redireciona de verdade
  return Response.redirect(dest, 302);
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
