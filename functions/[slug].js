const cors = {
  'Access-Control-Allow-Origin': '*'
};

export async function onRequestGet({ params, env, request }) {
  const slug = params.slug;
  const dest = await env.LINKS.get(slug);

  if (!dest) {
    await Promise.all([
      env.LINKS.delete(slug),
      env.STATS.delete(slug),
      env.LOGS.delete('log:' + slug),
      pruneDaily(env.STATS_DAY, slug)
    ]);
    return new Response('Not found', { status: 404, headers: cors });
  }

  const tot = parseInt(await env.STATS.get(slug) || '0', 10) + 1;
  env.STATS.put(slug, tot.toString());

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dKey = `${day}:${slug}`;
  const perDay = parseInt(await env.STATS_DAY.get(dKey) || '0', 10) + 1;
  env.STATS_DAY.put(dKey, perDay.toString());

  const ip = request.headers.get('CF-Connecting-IP');
  const loc = request.cf?.country || '??';
  let { latitude: lat = null, longitude: lon = null } = request.cf || {};
  if (lat == null || lon == null) {
    const CENTROID = { US: [37, -95], BR: [-14, -52], /* … */ };
    const c = CENTROID[loc.toUpperCase()];
    if (c) [lat, lon] = c;
  }
  const key = 'log:' + slug;
  const arr = safeJson(await env.LOGS.get(key));
  arr.unshift({ t: Date.now(), ip, loc, lat, lon });
  arr.length = Math.min(arr.length, 300);
  await env.LOGS.put(key, JSON.stringify(arr));

  return Response.redirect(dest, 302);
}

function safeJson(t) {
  if (!t || t === 'null') return [];
  try { return JSON.parse(t) } catch { return [] }
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
