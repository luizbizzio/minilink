// functions/[slug].js

export async function onRequest({ request, env, params, next }) {
  const { slug } = params;

  // Se for /admin (ou qualquer rota estática), serve o arquivo em public/
  if (slug === 'admin') {
    return next();
  }

  // Só GET são permitidos aqui
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Procura o destino no KV
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    // Se não existir, limpa possíveis restos e retorna 404
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status: 404 });
  }

  // Incrementa contador total
  const total = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
  env.STATS.put(slug, total.toString());

  // Incrementa contador diário
  const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
  const dayCount = parseInt(await env.STATS_DAY.get(dayKey) || '0', 10) + 1;
  env.STATS_DAY.put(dayKey, dayCount.toString());

  // Log de geolocalização
  let { latitude: lat = null, longitude: lon = null } = request.cf || {};
  if (lat == null || lon == null) {
    const CENTROIDS = {
      US:[37,-95], BR:[-14,-52], FR:[46,2],
      GB:[54,-2], DE:[51,10], IN:[22,79]
    };
    const fallback = CENTROIDS[request.cf?.country];
    if (fallback) [lat, lon] = fallback;
  }

  const logsKey = 'log:' + slug;
  const existing = JSON.parse(await env.LOGS.get(logsKey) || '[]');
  existing.unshift({
    t: Date.now(),
    ip: request.headers.get('CF-Connecting-IP'),
    loc: request.cf?.country,
    lat, lon
  });
  existing.length = Math.min(existing.length, 300);
  env.LOGS.put(logsKey, JSON.stringify(existing));

  // Finalmente redireciona
  return Response.redirect(dest, 302);
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix:'', limit:1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
