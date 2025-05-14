export async function onRequest(context) {
  const { request, env } = context;
  const url  = new URL(request.url);
  const path = url.pathname;

  if (path === '/admin' || path.startsWith('/admin/')) {
    return fetch(request);
  }

  if (path.startsWith('/api/list'))      return handleList(request, env);
  if (path.startsWith('/api/stats/'))    return handleStats(request, env);
  if (path.startsWith('/api/detail/'))   return handleDetail(request, env);
  if (path.startsWith('/api/delete/'))   return handleDelete(request, env);

  const slug = path.slice(1);
  if (/^[a-z0-9]{6}$/i.test(slug)) {
    return handleRedirect(slug, env);
  }

  return new Response('Not found', { status: 404 });
}
