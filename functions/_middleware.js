export async function onRequest(context) {
  const { request, next } = context;
  const path = new URL(request.url).pathname;

  if (
    path === '/' ||
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path.startsWith('/api/')
  ) {
    return await next();
  }

  return await next();
}
