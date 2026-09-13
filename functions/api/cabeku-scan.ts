import { assessGrowth, growthReferenceMeta, type GrowthMeasures, type GrowthVariety } from "./growth-engine";

type Env = { OPENAI_API_KEY?: string; CABEKU_MODEL?: string };
type ScanContext = { hst?: unknown; soil?: unknown; fertilization?: unknown; symptoms?: unknown; variety?: unknown; measurements?: unknown };
type ScanRequest = { imageDataUrl?: unknown; imageDataUrls?: unknown; context?: ScanContext };
type VisualReview = { photo_quality: "good" | "fair" | "poor"; status: "Sehat" | "Perlu Diamati" | "Perlu Pemeriksaan" | "Data Belum Cukup"; confidence: number; observations: string[]; caution: string; next_steps: string[] };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_STATUS = new Set(["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"]);
const RUNTIME_VERSION = "cabeku-cf-v5-multiphoto-2026-09-13";
const DEFAULT_MODEL = "gpt-4o-mini";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-cabeku-runtime": RUNTIME_VERSION,
    },
  });
}

function estimatedDataUrlBytes(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const base64 = value.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function isValidDataUrl(value: string): boolean {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || !ALLOWED_MIME.has(match[1])) return false;
  const bytes = estimatedDataUrlBytes(value);
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}

function normalizeImages(body: ScanRequest): string[] {
  const candidates: unknown[] = Array.isArray(body.imageDataUrls)
    ? body.imageDataUrls
    : typeof body.imageDataUrl === "string"
      ? [body.imageDataUrl]
      : [];
  return candidates.filter((value): value is string => typeof value === "string").slice(0, MAX_IMAGES);
}

function clampConfidence(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function fallbackConfidence(quality: VisualReview["photo_quality"], status: VisualReview["status"], observationCount: number): number {
  if (status === "Data Belum Cukup") return 0;
  const base = quality === "good" ? 72 : quality === "fair" ? 52 : 25;
  return Math.min(90, base + Math.min(18, observationCount * 3));
}

function sanitizeReview(value: unknown): VisualReview {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const quality = input.photo_quality === "good" || input.photo_quality === "fair" || input.photo_quality === "poor" ? input.photo_quality : "poor";
  const rawStatus = typeof input.status === "string" ? input.status : "Data Belum Cukup";
  const status = ALLOWED_STATUS.has(rawStatus) ? rawStatus as VisualReview["status"] : "Data Belum Cukup";
  const observations = Array.isArray(input.observations)
    ? input.observations.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 6)
    : [];
  const nextSteps = Array.isArray(input.next_steps)
    ? input.next_steps.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 5)
    : [];
  const caution = typeof input.caution === "string" && input.caution.trim()
    ? input.caution.slice(0, 500)
    : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis.";
  const rawConfidence = Number(input.confidence);
  let confidence = Number.isFinite(rawConfidence) ? clampConfidence(rawConfidence) : 0;
  if (confidence === 0 && status !== "Data Belum Cukup") {
    confidence = fallbackConfidence(quality, status, observations.length);
  }
  return { photo_quality: quality, status, confidence, observations, caution, next_steps: nextSteps };
}

function stripCodeFence(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function extractFirstJsonObject(value: string): string | null {
  const source = stripCodeFence(value);
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parseModelReview(content: unknown): VisualReview | null {
  const candidates: unknown[] = [content];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") candidates.push(part);
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        candidates.push(record.text, record.content, record.value, record.json);
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed: unknown = candidate;
    for (let depth = 0; depth < 4; depth += 1) {
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (typeof record.status === "string" || Array.isArray(record.observations) || typeof record.photo_quality === "string") {
          return sanitizeReview(record);
        }
        parsed = record.review ?? record.result ?? record.output ?? record.data ?? record.response ?? record.content ?? record.text ?? record.json;
        if (parsed === undefined || parsed === null) break;
        continue;
      }
      if (typeof parsed !== "string") break;
      const text = stripCodeFence(parsed);
      try { parsed = JSON.parse(text) as unknown; continue; } catch { /* fall through */ }
      const extracted = extractFirstJsonObject(text);
      if (!extracted) break;
      try { parsed = JSON.parse(extracted) as unknown; } catch { break; }
    }
  }
  return null;
}

function positiveNumber(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) return null;
  return number;
}

function normalizeGrowthContext(context: ScanContext | undefined): { hst: number | null; variety: GrowthVariety; measures: GrowthMeasures } {
  const rawHst = positiveNumber(context?.hst, 500);
  const rawVariety = typeof context?.variety === "string" ? context.variety : "unknown";
  const variety: GrowthVariety = rawVariety === "rawit" || rawVariety === "merah" || rawVariety === "keriting" ? rawVariety : "unknown";
  const measurements = context?.measurements && typeof context.measurements === "object" ? context.measurements as Record<string, unknown> : {};
  return {
    hst: rawHst,
    variety,
    measures: {
      heightCm: positiveNumber(measurements.heightCm, 500),
      canopyCm: positiveNumber(measurements.canopyCm, 500),
      leafCount: positiveNumber(measurements.leafCount, 1000),
      leafWidthCm: positiveNumber(measurements.leafWidthCm, 100),
    },
  };
}

function getPrompt(contextRecord: Record<string, unknown>, symptoms: string[], photoCount: number): string {
  return [
    "Anda adalah modul pemeriksaan visual awal tanaman cabai di Indonesia.",
    "Analisis seluruh foto sebagai SATU kasus tanaman, bukan per foto terpisah.",
    "Foto dapat menunjukkan sudut berbeda dari tanaman yang sama; jangan mencampur tanaman berbeda tanpa bukti.",
    "Hanya amati tanda yang benar-benar terlihat. Jangan menegakkan diagnosis penyakit atau menyebut patogen sebagai kepastian.",
    "Jangan memberi dosis pupuk, pestisida, fungisida, insektisida, atau bahan kimia.",
    "Gunakan status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
    "Gunakan Data Belum Cukup bila foto buram/gelap atau informasi visual utama tidak cukup.",
    "Confidence harus 1-100 untuk status selain Data Belum Cukup; jangan gunakan 0 untuk hasil yang masih dapat disimpulkan.",
    `Jumlah foto=${photoCount}; HST=${String(contextRecord.hst ?? "tidak diisi")}; tanah=${String(contextRecord.soil ?? "tidak diisi")}; pupuk=${String(contextRecord.fertilization ?? "tidak diisi")}; tanda=${symptoms.join(", ") || "tidak ada"}.`,
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    photo_quality: { type: "string", enum: ["good", "fair", "poor"] },
    status: { type: "string", enum: ["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    observations: { type: "array", items: { type: "string" }, maxItems: 6 },
    caution: { type: "string", maxLength: 500 },
    next_steps: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
  required: ["photo_quality", "status", "confidence", "observations", "caution", "next_steps"],
};

async function handleScan(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) return json({ error: "CABEKU_CF_MISSING_KEY: OPENAI_API_KEY belum tersedia." }, 500);
  let body: ScanRequest;
  try { body = await request.json() as ScanRequest; } catch { return json({ error: "CABEKU_CF_INVALID_JSON: Body JSON tidak valid." }, 400); }

  const images = normalizeImages(body);
  if (!images.length) return json({ error: "CABEKU_CF_INVALID_IMAGE: Minimal 1 foto diperlukan." }, 400);
  let totalBytes = 0;
  for (const image of images) {
    if (!isValidDataUrl(image)) return json({ error: "CABEKU_CF_INVALID_IMAGE: Foto harus JPG, PNG, atau WebP dan maksimal 5 MB per foto." }, 400);
    totalBytes += estimatedDataUrlBytes(image);
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return json({ error: "CABEKU_CF_IMAGE_PAYLOAD_TOO_LARGE: Total foto terlalu besar." }, 413);

  const context = body.context && typeof body.context === "object" ? body.context : {};
  const contextRecord = context as Record<string, unknown>;
  const symptoms = Array.isArray(contextRecord.symptoms) ? contextRecord.symptoms.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  const userContent: Array<Record<string, unknown>> = [
    { type: "text", text: "Periksa seluruh foto ini sebagai satu kasus tanaman cabai sesuai aturan sistem." },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image, detail: "high" } })),
  ];

  const model = typeof env.CABEKU_MODEL === "string" && env.CABEKU_MODEL.trim() ? env.CABEKU_MODEL.trim() : DEFAULT_MODEL;
  const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_schema", json_schema: { name: "cabeku_visual_review", strict: true, schema: RESPONSE_SCHEMA } },
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        { role: "system", content: getPrompt(contextRecord, symptoms, images.length) },
        { role: "user", content: userContent },
      ],
    }),
  });

  const rawText = await completionResponse.text();
  if (!completionResponse.ok) {
    console.error("Cabeku AI error", completionResponse.status, rawText.slice(0, 1000));
    return json({ error: `CABEKU_CF_OPENAI_ERROR: Layanan AI gagal merespons (${completionResponse.status}).` }, 502);
  }

  let completion: unknown;
  try { completion = JSON.parse(rawText); } catch { return json({ error: "CABEKU_CF_INVALID_OPENAI_RESPONSE: Respons AI bukan JSON valid." }, 502); }
  const record = completion as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined : undefined;
  if (message?.refusal) return json({ error: "CABEKU_CF_AI_REFUSAL: AI menolak memproses foto." }, 502);
  const review = parseModelReview(message?.content ?? message?.response ?? message?.output);
  if (!review) {
    console.error("Cabeku parse error", JSON.stringify({ contentType: typeof message?.content }));
    return json({ error: "CABEKU_CF_PARSE_ERROR: Format hasil AI tidak dapat dibaca." }, 502);
  }

  if (review.photo_quality === "poor") {
    review.status = "Data Belum Cukup";
    review.confidence = Math.min(review.confidence, 45);
    review.caution = "Foto belum cukup jelas untuk pemeriksaan visual yang bertanggung jawab. Ambil foto lebih terang dan fokus.";
    review.next_steps = ["Ambil foto ulang dengan cahaya cukup", "Tampilkan bagian tanaman yang bergejala", "Lengkapi HST dan kondisi tanah/media"];
  }

  const growthContext = normalizeGrowthContext(context);
  const growth = assessGrowth(growthContext.hst, growthContext.variety, growthContext.measures);
  return json({
    ok: true,
    runtime: RUNTIME_VERSION,
    review,
    photoCount: images.length,
    growth,
    audit: { engine: "cabeku-growth-engine-v1", reference: growthReferenceMeta(), benchmarkSource: growth.benchmark?.sourceId ?? null },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try { return await handleScan(request, env); }
  catch (error) {
    console.error("Cabeku runtime error", error);
    return json({ error: "CABEKU_CF_RUNTIME_ERROR: Pemeriksaan foto gagal diproses. Coba lagi." }, 500);
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  return onRequestPost(context);
};
