export async function onRequest(context) {
  // devolve para o Pages servir o static em public/admin/index.html
  return await context.next();
}
