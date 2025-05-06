// functions/[slug].js
export async function onRequest({ request, env, params }) {
  // só GET /<slug>
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status:405 });
  }

  const slug = params.slug;    // isso vem do arquivo [slug].js
  const dest = await env.LINKS.get(slug);
  if (!dest) {
    // limpa expirados
    await Promise.all([
      env.STATS.delete(slug),
      env.LOGS.delete('log:'+slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status:404 });
  }

  // incrementa tot e diário
  const tot = parseInt(await env.STATS.get(slug)||'0',10)+1;
  env.STATS.put(slug, tot.toString());
  const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'') + ':' + slug;
  const dCnt = parseInt(await env.STATS_DAY.get(dayKey)||'0',10)+1;
  env.STATS_DAY.put(dayKey, dCnt.toString());

  // log geo
  let { latitude:lat=null, longitude:lon=null } = request.cf||{};
  if (lat==null||lon==null) {
    const C = { US:[37,-95], BR:[-14,-52], FR:[46,2], GB:[54,-2], DE:[51,10], IN:[22,79] };
    const c = C[request.cf?.country];
    if (c) [lat,lon] = c;
  }
  const logsArr = JSON.parse(await env.LOGS.get('log:'+slug)||'[]');
  logsArr.unshift({
    t: Date.now(),
    ip: request.headers.get('CF-Connecting-IP'),
    loc: request.cf?.country,
    lat, lon
  });
  logsArr.length = Math.min(logsArr.length,300);
  env.LOGS.put('log:'+slug, JSON.stringify(logsArr));

  return Response.redirect(dest, 302);
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix:'', limit:1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':'+slug)).map(k => ns.delete(k.name))
  );
}
