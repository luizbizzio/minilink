const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestPost({ request, env }) {
  try {
    const { code, url: longUrl, ttl } = await request.json();
    if (!code || !/^https?:\/\//i.test(longUrl))
      return json({ error: 'bad payload' }, 400);

    await Promise.all([
      env.LINKS.delete(code),
      env.STATS.delete(code),
      env.LOGS.delete('log:' + code),
      pruneDaily(env.STATS_DAY, code)
    ]);

    const ttlSec = Math.min(Math.max(ttl ?? 0, 900), 2_592_000);
    const meta = {
      created: Date.now(),
      creator: {
        ip: request.headers.get('CF-Connecting-IP'),
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

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix: '', limit: 1000 });
  await Promise.all(
    keys
      .filter(k => k.name.endsWith(':' + slug))
      .map(k => ns.delete(k.name))
  );
}
