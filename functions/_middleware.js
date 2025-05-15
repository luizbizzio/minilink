// functions/_middleware.js

export async function onRequest(context) {
  const { request, env, next } = context;
  const url  = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 1) estáticos
  if (path === '/' || path.startsWith('/admin/')) {
    return await next();                     // serve public/ e public/admin/
  }

  // 2) API: GET /api/list
  if (method === 'GET' && path === '/api/list') {
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403 });
    const { keys } = await env.LINKS.list();
    const items = await Promise.all(
      keys.filter(k=>/^[a-z0-9]{6}$/i.test(k.name)).map(async k=>{
        const url = await env.LINKS.get(k.name);
        const m   = (await env.LINKS.getWithMetadata(k.name)).metadata||{};
        return { code:k.name, url, created:m.created, creator:m.creator, expiresIn:m.exp?m.exp-Date.now()/1000:null };
      })
    );
    return new Response(JSON.stringify(items), { headers:{'Content-Type':'application/json'} });
  }

  // 3) API: GET /api/stats/:slug
  if (method==='GET' && /^\/api\/stats\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.split('/').pop();
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403 });
    const clicks = parseInt(await env.STATS.get(slug)||'0',10);
    const logs   = JSON.parse(await env.LOGS.get('log:'+slug)||'[]');
    return new Response(JSON.stringify({ clicks, logs }), { headers:{'Content-Type':'application/json'} });
  }

  // 4) API: GET /api/detail/:slug
  if (method==='GET' && /^\/api\/detail\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.split('/').pop();
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) return new Response('Forbidden',{status:403});
    const clicksTotal = parseInt(await env.STATS.get(slug)||'0',10);
    const now = Date.now(), byDay={}, raw=JSON.parse(await env.LOGS.get('log:'+slug)||'[]');
    for(let i=0;i<30;i++){
      const d=new Date(now-i*864e5).toISOString().slice(0,10).replace(/-/g,'');
      const n=parseInt(await env.STATS_DAY.get(`${d}:${slug}`)||'0',10);
      if(n) byDay[d]=n;
    }
    const points = raw.filter(l=>l.lat!=null).map(l=>[l.lat,l.lon]);
    const byHour={}, created=(await env.LINKS.getWithMetadata(slug)).metadata?.created||now;
    if(now-created<864e5) raw.forEach(l=>{
      const h=new Date(l.t).getHours().toString().padStart(2,'0');
      byHour[h]=(byHour[h]||0)+1;
    });
    return new Response(JSON.stringify({ clicksTotal, byDay, byHour, points, logs:raw.slice(0,100) }),
      { headers:{'Content-Type':'application/json'} });
  }

  // 5) API: DELETE /api/delete/:slug
  if (method==='DELETE' && /^\/api\/delete\/[a-z0-9]{6}$/i.test(path)) {
    const slug = path.split('/').pop();
    const token = request.headers.get('X-Admin-Token');
    if (token !== env.ADMIN_TOKEN) return new Response('Forbidden',{status:403});
    await Promise.all([
      env.LINKS.delete(slug),
      env.STATS.delete(slug),
      env.LOGS.delete('log:'+slug),
      // ...pruneDaily se quiser
    ]);
    return new Response(JSON.stringify({ ok:true }), { headers:{'Content-Type':'application/json'} });
  }

  // 6) SLUG REDIRECT: GET /<6-char>
  if (method==='GET' && /^[a-z0-9]{6}$/i.test(path.slice(1))) {
    const slug = path.slice(1);
    const dest = await env.LINKS.get(slug);
    if (!dest) return new Response('Not found',{status:404});
    // incrementa stats (fire-and-forget)
    env.STATS.put(slug, (parseInt(await env.STATS.get(slug)||'0',10)+1).toString());
    const day=new Date().toISOString().slice(0,10).replace(/-/g,''), key=`${day}:${slug}`;
    env.STATS_DAY.put(key,(parseInt(await env.STATS_DAY.get(key)||'0',10)+1).toString());
    // opcional: log de localização…
    return Response.redirect(dest, 302);
  }

  // 7) tudo o mais → 404
  return new Response('Not found', { status: 404 });
}
