interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI: {
    run(
      model: string,
      input: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

type ScanBody = {
  imageDataUrl?: unknown;
  context?: {
    hst?: unknown;
    soil?: unknown;
    fertilization?: unknown;
    symptoms?: unknown;
  };
};

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_BASE64_CHARS = 7_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_STATUS = new Set([
  "Sehat",
  "Perlu Diamati",
  "Perlu Pemeriksaan",
  "Data Belum Cukup",
]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function validateImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 30 || value.length > MAX_BASE64_CHARS) {
    return false;
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  return Boolean(match && ALLOWED_MIME.has(match[1]));
}

function clampConfidence(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue)
    ? Math.max(0, Math.min(100, Math.round(numberValue)))
    : 0;
}

function sanitizeList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

function sanitizeReview(value: unknown) {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rawStatus = typeof input.status === "string" ? input.status : "Data Belum Cukup";
  const status = ALLOWED_STATUS.has(rawStatus) ? rawStatus : "Data Belum Cukup";
  const rawQuality = typeof input.photo_quality === "string" ? input.photo_quality : "poor";
  const photo_quality = rawQuality === "good" || rawQuality === "fair" || rawQuality === "poor" ? rawQuality : "poor";

  return {
    photo_quality,
    status,
    confidence: clampConfidence(input.confidence),
    observations: sanitizeList(input.observations, 6, 220),
    caution:
      typeof input.caution === "string"
        ? input.caution.trim().slice(0, 500)
        : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis penyakit.",
    next_steps: sanitizeList(input.next_steps, 5, 220),
  };
}

function buildPrompt(body: ScanBody): string {
  const context = body.context && typeof body.context === "object" ? body.context : {};
  const rawSymptoms = context.symptoms;
  const symptoms = Array.isArray(rawSymptoms)
    ? rawSymptoms.filter((item): item is string => typeof item === "string").slice(0, 10)
    : [];

  return [
    "Anda adalah Cabeku, modul pemeriksaan visual awal tanaman cabai untuk petani Indonesia.",
    "Amati foto secara konservatif dan hanya tuliskan hal yang benar-benar terlihat.",
    "Jangan mendiagnosis penyakit atau menyebut organisme penyebab secara pasti.",
    "Jangan memberi dosis pupuk, pestisida, fungisida, insektisida, atau bahan kimia.",
    "Gunakan tepat satu status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
    "Gunakan Data Belum Cukup bila foto buram, gelap, objek tanaman tidak jelas, atau bagian penting tidak terlihat.",
    "Perhatikan warna daun, bentuk daun, layu, bercak, kerusakan buah, kondisi tajuk, dan kualitas foto.",
    "Kembalikan JSON saja dengan format:",
    '{"photo_quality":"good|fair|poor","status":"Sehat|Perlu Diamati|Perlu Pemeriksaan|Data Belum Cukup","confidence":0,"observations":["..."],"caution":"...","next_steps":["..."]}',
    `Data pengguna: HST=${String(context.hst ?? "tidak diisi")}; tanah=${String(context.soil ?? "tidak diisi")}; pupuk=${String(context.fertilization ?? "tidak diisi")}; tanda terlihat=${symptoms.join(", ") || "tidak ada"}.`,
  ].join("\n");
}

async function scanImage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: ScanBody;
  try {
    body = (await request.json()) as ScanBody;
  } catch {
    return json({ error: "Format data tidak valid." }, 400);
  }

  if (!validateImageDataUrl(body.imageDataUrl)) {
    return json({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP." }, 400);
  }

  try {
    const result = await env.AI.run(MODEL, {
      prompt: buildPrompt(body),
      image: body.imageDataUrl,
      max_tokens: 700,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = (() => {
      if (typeof result === "string") return result;
      if (result && typeof result === "object") {
        const candidate = result as Record<string, unknown>;
        if (typeof candidate.response === "string") return candidate.response;
        if (typeof candidate.result === "string") return candidate.result;
      }
      return "";
    })();

    if (!raw) return json({ error: "Model tidak mengembalikan hasil." }, 502);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "Hasil AI tidak berbentuk JSON yang valid." }, 502);
    }

    const review = sanitizeReview(parsed);
    if (review.photo_quality === "poor") {
      review.status = "Data Belum Cukup";
      review.confidence = Math.min(review.confidence, 45);
      review.caution = "Foto belum cukup jelas untuk pemeriksaan visual yang bertanggung jawab.";
      review.next_steps = [
        "Ambil foto dengan cahaya cukup dan fokus",
        "Tampilkan seluruh tanaman atau bagian bergejala",
        "Lengkapi HST dan kondisi tanah/media",
      ];
    }

    return json({ ok: true, review });
  } catch (error) {
    console.error("Cabeku Cloudflare AI scan error", error);
    return json({ error: "Pemeriksaan foto gagal diproses. Coba lagi." }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/cabeku-scan") {
      return scanImage(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "API endpoint tidak ditemukan." }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
