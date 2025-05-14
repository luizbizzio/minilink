export async function onRequest({ request, next }) {
  const url  = new URL(request.url);
  const path = url.pathname;

  if (path === '/admin') {
    url.pathname = '/admin/';
    return Response.redirect(url.toString(), 308);
  }

  if (
    path === '/' ||
    path.startsWith('/admin/') ||
    path.startsWith('/api/')
  ) {
    return await next();
  }

  return await next();
}
