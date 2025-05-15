// functions/[slug].js

export async function onRequestGet({ params, env }) {
  const slug = params.slug;

  // 1) Só trata slugs válidos de 6 chars
  if (!/^[a-z0-9]{6}$/i.test(slug)) {
    return new Response('Not found', { status: 404 });
  }

  // 2) Busca destino
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

  // 3) Incrementa contadores
  const total = (parseInt(await env.STATS.get(slug) || '0', 10) + 1).toString();
  env.STATS.put(slug, total);

  const day     = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const dKey    = `${day}:${slug}`;
  const daily   = (parseInt(await env.STATS_DAY.get(dKey) || '0', 10) + 1).toString();
  env.STATS_DAY.put(dKey, daily);

  // 4) (Opcional) Log de localização
  const ip  = request.headers.get('CF-Connecting-IP');
  const loc = request.cf?.country || '??';
  const raw = await env.LOGS.get('log:' + slug) || '[]';
  const arr = JSON.parse(raw);
  arr.unshift({ t: Date.now(), ip, loc });
  arr.length = Math.min(arr.length, 300);
  await env.LOGS.put('log:' + slug, JSON.stringify(arr));

  // 5) Redireciona de verdade
  return Response.redirect(dest, 302);
}

// Limpa chaves diárias antigas
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
