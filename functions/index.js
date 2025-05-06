// functions/index.js
export async function onRequest({ request, env, next }) {
  if (request.method === 'POST') {
    let body;
    try { body = await request.json() }
    catch {
      return new Response(JSON.stringify({ error:'invalid json' }), {
        status:400, headers:{'Content-Type':'application/json'}
      })
    }
    const { code, url: longUrl, ttl } = body;
    if (!code || !/^https?:\/\//i.test(longUrl)) {
      return new Response(JSON.stringify({ error:'bad payload' }), {
        status:400, headers:{'Content-Type':'application/json'}
      })
    }
    // limpa dados antigos
    await Promise.all([
      env.STATS.delete(code),
      env.LOGS.delete('log:'+code),
      pruneDaily(env.STATS_DAY, code)
    ]);
    // grava no KV
    const ttlSec = Math.min(Math.max(ttl??0,900),2592000);
    await env.LINKS.put(code, longUrl, {
      expirationTtl: ttlSec,
      metadata: { created: Date.now() }
    });
    return new Response(JSON.stringify({ ok:true, code }), {
      status:200, headers:{'Content-Type':'application/json'}
    });
  }

  // no GET "/" ou qualquer outra rota estática, cai aqui
  return next();
}

async function pruneDaily(ns, slug) {
  const { keys } = await ns.list({ prefix:'', limit:1000 });
  await Promise.all(
    keys.filter(k => k.name.endsWith(':'+slug)).map(k => ns.delete(k.name))
  );
}
