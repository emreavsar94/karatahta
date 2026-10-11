export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping") {
      return Response.json({ mesaj: "Worker calisiyor" });
    }

    return new Response("Bulunamadi", { status: 404 });
  },
};