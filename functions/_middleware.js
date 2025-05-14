export async function onRequest({ request, next }) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // redireciona /admin → /admin/
  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }

  // serve estático para /, /admin/* etc.
  if (
    path === '/' ||
    path.startsWith('/admin/') ||
    path.startsWith('/api/')
  ) {
    return await next();
  }

  // resto (slug) vai pro [slug].js
  return await next();
}
