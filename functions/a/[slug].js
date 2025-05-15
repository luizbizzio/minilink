// functions/[slug].js

export async function onRequestGet({ request, params, env }) {
  const slug = params.slug;

  // 1) Só trata slugs válidos de 6 chars
  if (!/^[a-z0-9]{6}$/i.test(slug)) {
    return new Response('Not found', { status: 404 });
  }

  // 2) Busca destino no KV
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    // opcional: limpeza de estatísticas órfãs
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status: 404 });
  }

  // 3) Incrementa contador total (fire-and-forget)
  env.STATS.put(
    slug,
    (parseInt(await env.STATS.get(slug) || '0', 10) + 1).toString()
  );

  // 4) Incrementa estatística diária
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dailyKey = `${today}:${slug}`;
  env.STATS_DAY.put(
    dailyKey,
    (parseInt(await env.STATS_DAY.get(dailyKey) || '0', 10) + 1).toString()
  );

  // 5) Log de localização (opcional)
  const ip = request.headers.get('CF-Connecting-IP');
  const loc = request.cf?.country || '??';
  const raw = await env.LOGS.get('log:' + slug) || '[]';
  const arr = JSON.parse(raw);
  arr.unshift({ t: Date.now(), ip, loc });
  arr.length = Math.min(arr.length, 300);
  env.LOGS.put('log:' + slug, JSON.stringify(arr));

  // 6) Redireciona de verdade
  return Response.redirect(dest, 302);
}

// Helper para limpar chaves diárias antigas
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
