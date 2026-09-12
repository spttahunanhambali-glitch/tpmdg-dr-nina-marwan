const RUNTIME = "cabeku-cf-v4-growth-2026-09-12-jsonfix";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-cabeku-runtime": RUNTIME,
    },
  });
}

export const onRequest: PagesFunction = async ({ request }) => {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return json({
    ok: true,
    service: "cabeku",
    runtime: RUNTIME,
    engine: "cabeku-growth-engine-v1",
    purpose: "deployment-health",
  });
};
