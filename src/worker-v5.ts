import {
  assessGrowth,
  growthReferenceMeta,
  type GrowthVariety,
} from "../functions/api/growth-engine";

type Env = {
  ASSETS: { fetch(r: Request): Promise<Response> };
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
};

type Ctx = {
  hst?: unknown;
  soil?: unknown;
  fertilization?: unknown;
  symptoms?: unknown;
  variety?: unknown;
  measurements?: unknown;
};

type Body = {
  imageDataUrl?: unknown;
  imageDataUrls?: unknown;
  context?: Ctx;
};

type Status = "Sehat" | "Perlu Diamati" | "Perlu Pemeriksaan" | "Data Belum Cukup";
type Quality = "good" | "fair" | "poor";

type Review = {
  photo_quality: Quality;
  status: Status;
  confidence: number;
  conclusion: string;
  observations: string[];
  caution: string;
  next_steps: string[];
};

type PhotoDiagnostic = {
  image_index: number;
  ai_called: boolean;
  ai_response_received: boolean;
  parsed: boolean;
  parser_status: "ok" | "unparsed";
  confidence_source: "model" | "default_zero_after_parse_failure" | "missing";
  output_type: string;
  response_keys: string[];
  raw_excerpt: string;
  error: string | null;
};

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const RUNTIME = "cabeku-worker-v7.1-vision-messages-diagnostic-2026-09-13";
const STATUSES = ["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"] as const;
const QUALITIES = ["good", "fair", "poor"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    photo_quality: { type: "string", enum: [...QUALITIES] },
    status: { type: "string", enum: [...STATUSES] },
    confidence: { type: "number", minimum: 1, maximum: 100 },
    conclusion: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    caution: { type: "string" },
    next_steps: { type: "array", items: { type: "string" } },
  },
  required: ["photo_quality", "status", "confidence", "conclusion", "observations", "caution", "next_steps"],
} as const;

const response = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-cabeku-runtime": RUNTIME,
    },
  });

const clampConfidence = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
};
const asText = (value: unknown, max = 600): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const asList = (value: unknown, max = 6): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];

const parseJson = (value: unknown): unknown | null => {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(source) as unknown;
    return typeof parsed === "string" ? parseJson(parsed) : parsed;
  } catch {
    // Tolerant extraction below.
  }
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
};

const extractCandidate = (value: unknown, depth = 0): unknown => {
  if (depth > 8 || value === null || value === undefined) return null;
  const parsed = parseJson(value);
  if (parsed === null) return null;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const candidate = extractCandidate(item, depth + 1);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof parsed !== "object") return null;
  const object = parsed as Record<string, unknown>;
  const status = object.status ?? object.Status ?? object.overall_status;
  const quality = object.photo_quality ?? object.photoQuality ?? object.quality;
  if (
    typeof status === "string" &&
    (STATUSES as readonly string[]).includes(status) &&
    typeof quality === "string" &&
    (QUALITIES as readonly string[]).includes(quality)
  ) return object;
  for (const key of ["review", "result", "response", "output", "data", "content", "message", "json"]) {
    if (key in object) {
      const candidate = extractCandidate(object[key], depth + 1);
      if (candidate) return candidate;
    }
  }
  for (const nested of Object.values(object)) {
    const candidate = extractCandidate(nested, depth + 1);
    if (candidate) return candidate;
  }
  return null;
};

const normalizeReview = (value: unknown): Review | null => {
  const candidate = extractCandidate(value);
  if (!candidate || typeof candidate !== "object") return null;
  const object = candidate as Record<string, unknown>;
  const status = object.status ?? object.Status ?? object.overall_status;
  const quality = object.photo_quality ?? object.photoQuality ?? object.quality;
  if (
    typeof status !== "string" ||
    !(STATUSES as readonly string[]).includes(status) ||
    typeof quality !== "string" ||
    !(QUALITIES as readonly string[]).includes(quality)
  ) return null;
  return {
    photo_quality: quality as Quality,
    status: status as Status,
    confidence: clampConfidence(object.confidence ?? object.confidence_score ?? object.confidenceScore),
    conclusion: asText(object.conclusion ?? object.summary ?? object.kesimpulan) || "Belum ada kesimpulan yang cukup kuat dari foto.",
    observations: asList(object.observations ?? object.visual_observations ?? object.pengamatan),
    caution: asText(object.caution ?? object.warning ?? object.catatan, 500) || "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis penyakit.",
    next_steps: asList(object.next_steps ?? object.nextSteps ?? object.langkah_berikutnya, 5),
  };
};

const buildPrompt = (context: Ctx | undefined): string => {
  const value = context ?? {};
  const symptoms = Array.isArray(value.symptoms)
    ? value.symptoms.filter((item): item is string => typeof item === "string").join(", ")
    : "—";
  return [
    "Anda adalah Cabeku, pemeriksaan visual awal tanaman cabai Indonesia.",
    "Analisis SATU foto tanaman yang diberikan.",
    "Hanya tuliskan ciri yang benar-benar terlihat pada foto.",
    "Jangan mendiagnosis penyakit atau patogen dan jangan memberi dosis pupuk atau pestisida.",
    "Gunakan status Sehat, Perlu Diamati, Perlu Pemeriksaan, atau Data Belum Cukup.",
    "Jangan memilih Data Belum Cukup hanya karena HST, tanah, pupuk, varietas, atau gejala belum diisi.",
    "Gunakan Data Belum Cukup hanya jika objek tanaman tidak terlihat cukup jelas untuk observasi visual.",
    "Jika foto jelas, wajib berikan sedikitnya satu observasi visual nyata dan confidence 1-100.",
    "Confidence 0 tidak diperbolehkan untuk foto yang jelas.",
    "Fase bibit atau vegetatif boleh disebut berdasarkan ciri visual tanpa mengarang HST.",
    "Kembalikan JSON tunggal tanpa markdown dengan field photo_quality,status,confidence,conclusion,observations,caution,next_steps.",
    `Konteks lapangan: HST=${String(value.hst ?? "—")}; varietas=${String(value.variety ?? "—")}; tanah=${String(value.soil ?? "—")}; pupuk=${String(value.fertilization ?? "—")}; gejala=${symptoms}.`,
  ].join("\n");
};

const getImages = (body: Body): string[] => {
  const values = Array.isArray(body.imageDataUrls) ? body.imageDataUrls : typeof body.imageDataUrl === "string" ? [body.imageDataUrl] : [];
  return values.filter((value): value is string => typeof value === "string").slice(0, 5);
};
const validImage = (value: string): boolean => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 7_000_000;

const describeAiOutput = (value: unknown) => {
  if (value === null || value === undefined) return { type: "null", keys: [] as string[] };
  if (Array.isArray(value)) return { type: "array", keys: [] as string[] };
  if (typeof value === "string") return { type: "string", keys: [] as string[] };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 20) };
  return { type: typeof value, keys: [] as string[] };
};
const rawExcerpt = (value: unknown): string => {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized ? serialized.slice(0, 700) : "";
  } catch {
    return "";
  }
};

const analyzeOne = async (
  env: Env,
  context: Ctx | undefined,
  image: string,
  imageIndex: number,
): Promise<{ review: Review | null; diagnostic: PhotoDiagnostic }> => {
  let aiOutput: unknown = null;
  let aiError: string | null = null;
  try {
    const input = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(context) },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      guided_json: SCHEMA,
      max_tokens: 900,
      temperature: 0.1,
      stream: false,
    };
    aiOutput = await env.AI.run(MODEL, input);
  } catch (error) {
    aiError = error instanceof Error ? error.message : String(error);
  }
  const review = normalizeReview(aiOutput);
  const outputDescription = describeAiOutput(aiOutput);
  return {
    review,
    diagnostic: {
      image_index: imageIndex + 1,
      ai_called: true,
      ai_response_received: aiOutput !== null,
      parsed: review !== null,
      parser_status: review ? "ok" : "unparsed",
      confidence_source: review ? "model" : aiError ? "missing" : "default_zero_after_parse_failure",
      output_type: outputDescription.type,
      response_keys: outputDescription.keys,
      raw_excerpt: rawExcerpt(aiOutput),
      error: aiError,
    },
  };
};

const qualityToVisual = (review: Review): Review => {
  if (review.photo_quality !== "poor") return review;
  return {
    ...review,
    status: "Data Belum Cukup",
    confidence: Math.min(review.confidence || 1, 45),
    conclusion: "Foto belum cukup jelas untuk menarik kesimpulan visual yang bertanggung jawab.",
    next_steps: ["Ambil foto dengan cahaya cukup dan fokus", "Tampilkan satu tanaman utama"],
  };
};

const mergeReviews = (reviews: Review[]): Review => {
  if (!reviews.length) return {
    photo_quality: "poor",
    status: "Data Belum Cukup",
    confidence: 0,
    conclusion: "Tidak ada hasil visual yang dapat dibaca dari AI.",
    observations: [],
    caution: "Pemeriksaan visual belum berhasil menghasilkan data yang dapat dibaca.",
    next_steps: ["Ulangi pemeriksaan dengan foto tanaman yang jelas"],
  };
  const severity: Record<Status, number> = { Sehat: 0, "Perlu Diamati": 1, "Perlu Pemeriksaan": 2, "Data Belum Cukup": 3 };
  const overall = reviews.reduce((best, current) => severity[current.status] > severity[best.status] ? current : best);
  const averageConfidence = Math.round(reviews.reduce((sum, review) => sum + review.confidence, 0) / reviews.length);
  return {
    photo_quality: reviews.some((review) => review.photo_quality === "good") ? "good" : "fair",
    status: overall.status,
    confidence: averageConfidence,
    conclusion: overall.conclusion,
    observations: [...new Set(reviews.flatMap((review) => review.observations))].slice(0, 10),
    caution: reviews.map((review) => review.caution).filter(Boolean).slice(0, 2).join(" "),
    next_steps: [...new Set(reviews.flatMap((review) => review.next_steps))].slice(0, 6),
  };
};

const growth = (context: Ctx | undefined) => {
  const numeric = (value: unknown, max: number): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 && result <= max ? result : null;
  };
  const rawVariety = typeof context?.variety === "string" ? context.variety : "unknown";
  const variety: GrowthVariety = ["rawit", "merah", "keriting"].includes(rawVariety) ? (rawVariety as GrowthVariety) : "unknown";
  const measures = context?.measurements && typeof context.measurements === "object" ? (context.measurements as Record<string, unknown>) : {};
  return {
    hst: numeric(context?.hst, 500),
    variety,
    measures: {
      heightCm: numeric(measures.heightCm, 500),
      canopyCm: numeric(measures.canopyCm, 500),
      leafCount: numeric(measures.leafCount, 1000),
      leafWidthCm: numeric(measures.leafWidthCm, 100),
    },
  };
};

async function scan(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type" } });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  let body: Body;
  try { body = (await req.json()) as Body; } catch { return response({ error: "Format data tidak valid." }, 400); }
  const images = getImages(body);
  if (!images.length || images.some((image) => !validImage(image))) return response({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP." }, 400);

  try {
    const results: Array<{ review: Review; diagnostic: PhotoDiagnostic }> = [];
    for (let index = 0; index < images.length; index += 1) {
      const result = await analyzeOne(env, body.context, images[index], index);
      if (result.review) {
        results.push({ review: qualityToVisual(result.review), diagnostic: result.diagnostic });
      } else {
        results.push({
          review: {
            photo_quality: "poor",
            status: "Data Belum Cukup",
            confidence: 0,
            conclusion: "Respons AI tidak dapat dibaca. Ini adalah kegagalan pemrosesan, bukan penilaian bahwa tanaman buruk.",
            observations: [],
            caution: "Pemeriksaan visual gagal diparse sehingga hasil tidak boleh dianggap sebagai diagnosis atau penilaian kesehatan tanaman.",
            next_steps: ["Ulangi pemeriksaan dengan foto yang sama", "Periksa diagnostic parser/runtime"],
          },
          diagnostic: result.diagnostic,
        });
      }
    }

    const reviewList = results.map((item) => item.review);
    const usableReviews = reviewList.filter((review) => review.observations.length > 0 || review.confidence > 0 || review.status !== "Data Belum Cukup");
    const merged = mergeReviews(usableReviews);
    const successfulCount = results.filter((item) => item.diagnostic.parsed).length;
    const g = growth(body.context);
    const growthAssessment = assessGrowth(g.hst, g.variety, g.measures);

    return response({
      ok: true,
      runtime: RUNTIME,
      model: MODEL,
      review: merged,
      reviews: reviewList,
      growth: growthAssessment,
      audit: {
        engine: "cabeku-growth-engine-v1",
        reference: growthReferenceMeta(),
        benchmarkSource: growthAssessment.benchmark?.sourceId ?? null,
        photo_count: images.length,
        successful_ai_parse: successfulCount,
        failed_ai_parse: results.length - successfulCount,
        diagnostic: results.map((item) => item.diagnostic),
      },
    });
  } catch (error) {
    console.error("Cabeku scan error", error instanceof Error ? error.message : String(error));
    return response({ error: "Pemeriksaan AI gagal atau respons AI tidak dapat diproses.", runtime: RUNTIME, model: MODEL }, 502);
  }
}

async function page(req: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL("/cabeku/index.html", req.url), req));
  if (!asset.ok) return new Response("Cabeku page asset tidak ditemukan.", { status: 404 });
  const html = await asset.text();
  const scripts = ["/cabeku/multi-photo.js", "/cabeku/reset-bridge.js"].filter((path) => !html.includes(path)).map((path) => `<script src="${path}" defer></script>`).join("");
  return scripts ? new Response(html.replace("</body>", `${scripts}</body>`), asset) : new Response(html, asset);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/cabeku-scan") return scan(req, env);
    if (url.pathname === "/api/cabeku-health") return response({ ok: true, service: "cabeku", runtime: RUNTIME, model: MODEL, engine: "cabeku-growth-engine-v1" });
    if (url.pathname.startsWith("/api/")) return response({ error: "API endpoint tidak ditemukan." }, 404);
    if (["/cabeku", "/cabeku/", "/cabeku/index.html", "/serba-serbi/cabeku", "/serba-serbi/cabeku/", "/serba-serbi/cabeku/index.html"].includes(url.pathname)) return page(req, env);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
