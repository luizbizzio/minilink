export async function onRequest({ request, next }) {
  // let static handle "/", "/admin/" and anything under "/admin/"
  const p = new URL(request.url).pathname;
  if (p === '/' || p.startsWith('/admin/')) {
    return next();
  }
  // otherwise, fall back to the slug handler
  return next();
}
