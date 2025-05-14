// functions/admin.js
export async function onRequestGet({ request }) {
  // devolve pro Pages servir o static em public/admin/index.html
  return fetch(request);
}
