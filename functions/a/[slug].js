// functions/[slug].js

export async function onRequestGet({ params, env }) {
  const slug = params.slug;    
  // 1) Só aceita slugs de 6 caracteres alfanuméricos
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

  // 3) Incrementa contador total
  const total = (parseInt(await env.STATS.get(slug) || '0', 10) + 1).toString();
  env.STATS.put(slug, total);

  // 4) Incrementa estatística diária
  const todayKey = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const dailyKey = `${todayKey}:${slug}`;
  const daily = (parseInt(await env.STATS_DAY.get(dailyKey) || '0', 10) + 1).toString();
  env.STATS_DAY.put(dailyKey, daily);

  // 5) (Opcional) Log de localização
  const ip  = env.CF ? env.CF.connecting_ip : null; // ou use request.headers
  const loc = env.CF ? env.CF.country : '??';
  const raw = await env.LOGS.get('log:' + slug) || '[]';
  const arr = JSON.parse(raw);
  arr.unshift({ t: Date.now(), ip, loc });
  arr.length = Math.min(arr.length, 300);
  await env.LOGS.put('log:' + slug, JSON.stringify(arr));

  // 6) Redireciona de verdade
  return Response.redirect(dest, 302);
}

// Helper para limpeza diária
async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
