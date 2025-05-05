// functions/[...slug].js

/**
 * URL-Shortener – TTL • clicks diários/horários • heat-map • painel
 * Pages Function catch-all: trata /api/*, /slug e entrega assets estáticos
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
};

const CENTROID = {
  US:[37,-95], BR:[-14,-52], FR:[46,2],
  GB:[54,-2], DE:[51,10], IN:[22,79]
};

export async function onRequest(context) {
  const { request, env } = context;
  const url   = new URL(request.url);
  const path  = url.pathname.replace(/^\/+/, '');
  const meth  = request.method;

  // preflight CORS
  if (meth === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // ─────── ADMIN API ───────
  if (path.startsWith('api/')) {
    // auth
    if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN) {
      return json({ error:'Forbidden' }, 403);
    }
    // GET /api/list
    if (meth==='GET' && path==='api/list') {
      const list = await env.LINKS.list();
      const items = await Promise.all(
        list.keys
            .filter(k=>/^[a-z0-9]{6}$/i.test(k.name))
            .map(async k=>{
              const meta = (await env.LINKS.getWithMetadata(k.name)).metadata||{};
              return {
                code     : k.name,
                url      : await env.LINKS.get(k.name),
                created  : meta.created||0,
                creator  : meta.creator||null,
                expiresIn: meta.exp ? meta.exp - Date.now()/1000 : null
              };
            })
      );
      return json(items);
    }
    // GET /api/stats/:slug
    if (meth==='GET' && /^api\/stats\/[a-z0-9]{6}$/i.test(path)) {
      const slug = path.split('/').pop();
      const creator = (await env.LINKS.getWithMetadata(slug))
                        .metadata?.creator || null;
      return json({
        clicks: parseInt(await env.STATS.get(slug)||'0',10),
        logs  : safeJson(await env.LOGS.get('log:'+slug)).slice(0,20),
        creator
      });
    }
    // GET /api/detail/:slug
    if (meth==='GET' && /^api\/detail\/[a-z0-9]{6}$/i.test(path)) {
      const slug        = path.split('/').pop();
      const clicksTotal = parseInt(await env.STATS.get(slug)||'0',10);

      // últimos 30 dias
      const byDay = {}, now = Date.now();
      for(let i=0;i<30;i++){
        const d = new Date(now - i*864e5)
                    .toISOString().slice(0,10).replace(/-/g,'');
        const n = parseInt(await env.STATS_DAY.get(`${d}:${slug}`)||'0',10);
        if(n) byDay[d] = n;
      }

      const rawLogs = safeJson(await env.LOGS.get('log:'+slug));
      const points  = rawLogs.filter(l=>l.lat!=null)
                             .map(l=>[l.lat,l.lon]);
      // se <24h → por hora
      let byHour = {}, created = 
          (await env.LINKS.getWithMetadata(slug)).metadata?.created || now;
      if (now - created < 86_400_000) {
        rawLogs.forEach(l=>{
          const h = new Date(l.t).getHours()
                      .toString().padStart(2,'0');
          byHour[h] = (byHour[h]||0)+1;
        });
      }

      return json({ clicksTotal, byDay, byHour, points,
                    logs: rawLogs.slice(0,100) });
    }
    // DELETE /api/delete/:slug
    if (meth==='DELETE' && /^api\/delete\/[a-z0-9]{6}$/i.test(path)) {
      const slug = path.split('/').pop();
      await Promise.all([
        env.LINKS.delete(slug),
        env.STATS.delete(slug),
        env.LOGS.delete('log:'+slug),
        pruneDaily(env.STATS_DAY, slug)
      ]);
      return json({ ok:true });
    }

    return json({ error:'Not found' },404);
  }

  // ─────── Criar link (POST /) ───────
  if (meth==='POST') {
    try {
      const { code, url: longUrl, ttl } = await request.json();
      if (!code || !longUrl || !/^https?:\/\//i.test(longUrl)) {
        return json({ error:'bad payload' },400);
      }
      // limpa dados antigos
      await Promise.all([
        env.STATS.delete(code),
        env.LOGS.delete('log:'+code),
        pruneDaily(env.STATS_DAY, code)
      ]);
      const ttlSec = Math.min(Math.max(ttl??0,900),2_592_000);
      const meta = {
        created: Date.now(),
        creator:{
          ip : request.headers.get('CF-Connecting-IP'),
          loc: request.cf?.country||'??'
        },
        exp: Date.now()/1000 + ttlSec
      };
      const opts = ttlSec
        ? { expirationTtl:ttlSec, metadata:meta }
        : { metadata:meta };
      await env.LINKS.put(code, longUrl, opts);
      return json({ ok:true, code });
    } catch {
      return json({ error:'invalid json' },400);
    }
  }

  // ─────── Redirecionar /<slug> ───────
  if (meth==='GET' && /^[a-z0-9]{6}$/i.test(path)) {
    const slug = path;
    const dest = await env.LINKS.get(slug);
    // expirado?
    if (!dest) {
      await Promise.all([
        env.STATS.delete(slug),
        env.LOGS.delete('log:'+slug),
        pruneDaily(env.STATS_DAY, slug)
      ]);
      return new Response('Not found',{status:404});
    }
    // total
    const tot = parseInt(await env.STATS.get(slug)||'0',10)+1;
    env.STATS.put(slug, tot.toString());
    // diário
    const day  = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const dKey = `${day}:${slug}`;
    const perDay = parseInt(await env.STATS_DAY.get(dKey)||'0',10)+1;
    env.STATS_DAY.put(dKey, perDay.toString());
    // log geo
    let { latitude:lat=null, longitude:lon=null } = request.cf||{};
    const ip  = request.headers.get('CF-Connecting-IP');
    const loc = request.cf?.country||'??';
    if (lat==null||lon==null) {
      const c = CENTROID[loc.toUpperCase()];
      if (c) [lat,lon] = c;
    }
    const key = 'log:'+slug;
    const arr = safeJson(await env.LOGS.get(key));
    arr.unshift({ t:Date.now(), ip, loc, lat, lon });
    arr.length = Math.min(arr.length,300);
    await env.LOGS.put(key, JSON.stringify(arr));
    return Response.redirect(dest,302);
  }

  // ─────── estáticos ───────
  if (meth === 'GET') {
  return env.ASSETS.fetch(request);
}
return new Response('Method Not Allowed', { status: 405 });
}

/* ────── helpers ────── */
const json = (d,s=200) => new Response(JSON.stringify(d),{
  status:s,headers:{'Content-Type':'application/json',...cors}
});

const safeJson = t => {
  if (!t||t==='null') return [];
  try { return JSON.parse(t) } catch { return [] }
};

async function pruneDaily(ns, slug){
  const { keys } = await ns.list({ prefix:'', limit:1000 });
  await Promise.all(
    keys.filter(k=>k.name.endsWith(':'+slug))
        .map(k=>ns.delete(k.name))
  );
}
