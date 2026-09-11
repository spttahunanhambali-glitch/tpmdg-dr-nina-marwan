import OpenAI from "openai";

type ScanRequest = {
  imageDataUrl?: unknown;
  context?: { hst?: unknown; soil?: unknown; fertilization?: unknown; symptoms?: unknown };
};

type VisualReview = {
  photo_quality: "good" | "fair" | "poor";
  status: "Sehat" | "Perlu Diamati" | "Perlu Pemeriksaan" | "Data Belum Cukup";
  confidence: number;
  observations: string[];
  caution: string;
  next_steps: string[];
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_STATUS = new Set(["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isValidDataUrl(value: string): boolean {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || !ALLOWED_MIME.has(match[1])) return false;
  const base64 = match[2];
  const estimatedBytes = Math.floor((base64.length * 3) / 4)
    - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  return estimatedBytes > 0 && estimatedBytes <= MAX_IMAGE_BYTES;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

function sanitizeReview(value: unknown): VisualReview {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const quality = input.photo_quality === "good"
    || input.photo_quality === "fair"
    || input.photo_quality === "poor"
    ? input.photo_quality
    : "poor";
  const rawStatus = typeof input.status === "string" ? input.status : "Data Belum Cukup";
  const status = ALLOWED_STATUS.has(rawStatus)
    ? (rawStatus as VisualReview["status"])
    : "Data Belum Cukup";
  const observations = Array.isArray(input.observations)
    ? input.observations.filter((x): x is string => typeof x === "string").slice(0, 6)
    : [];
  const nextSteps = Array.isArray(input.next_steps)
    ? input.next_steps.filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];
  const caution = typeof input.caution === "string"
    ? input.caution.slice(0, 500)
    : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis.";

  return {
    photo_quality: quality,
    status,
    confidence: clampConfidence(input.confidence),
    observations,
    caution,
    next_steps: nextSteps,
  };
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function extractFirstJsonObject(value: string): string | null {
  const source = stripCodeFence(value);
  const start = source.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

function parseJsonLoose(value: unknown): unknown | null {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;

  const trimmed = stripCodeFence(value);
  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function unwrapReview(value: unknown): unknown | null {
  let current = parseJsonLoose(value);
  for (let i = 0; i < 4 && current && typeof current === "object"; i += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.status === "string" || Array.isArray(record.observations)) {
      return record;
    }

    const candidates = [
      record.review,
      record.result,
      record.output,
      record.data,
      record.response,
      record.content,
      record.text,
    ];

    const next = candidates.find((candidate) => candidate !== undefined && candidate !== null);
    if (next === undefined) return record;
    current = parseJsonLoose(next);
  }
  return current;
}

function parseModelReview(content: unknown): VisualReview | null {
  const candidates: unknown[] = [content];

  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") candidates.push(part);
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        candidates.push(record.text, record.content, record.value);
      }
    }
  }

  for (const candidate of candidates) {
    const unwrapped = unwrapReview(candidate);
    if (unwrapped && typeof unwrapped === "object") {
      const review = sanitizeReview(unwrapped);
      const raw = unwrapped as Record<string, unknown>;
      const looksValid = typeof raw.status === "string"
        || Array.isArray(raw.observations)
        || typeof raw.photo_quality === "string";
      if (looksValid) return review;
    }
  }

  return null;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as ScanRequest;
    const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";

    if (!isValidDataUrl(imageDataUrl)) {
      return json({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP maksimal 5 MB setelah kompresi." }, 400);
    }

    const context = body.context && typeof body.context === "object" ? body.context : {};
    const contextRecord = context as Record<string, unknown>;
    const symptoms = Array.isArray(contextRecord.symptoms)
      ? contextRecord.symptoms.filter((x): x is string => typeof x === "string").slice(0, 10)
      : [];

    const openai = new OpenAI();
    const prompt = [
      "Anda adalah modul pemeriksaan visual awal untuk aplikasi budidaya tanaman cabai di Indonesia.",
      "Hanya amati foto. Jangan menegakkan diagnosis penyakit, jangan menyebut patogen secara pasti, jangan memberi dosis pupuk, pestisida, fungisida, insektisida, atau bahan kimia.",
      "Gunakan status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
      "Gunakan Data Belum Cukup bila objek tidak jelas, buram/gelap, atau bagian penting tanaman tidak terlihat.",
      "Observasi harus berbasis yang terlihat: warna daun, bentuk daun, layu, bercak, kerusakan buah, kondisi tajuk, dan kualitas foto. Jangan menebak.",
      "Kembalikan SATU objek JSON saja tanpa markdown, tanpa backtick, tanpa teks pembuka/penutup.",
      '{"photo_quality":"good|fair|poor","status":"Sehat|Perlu Diamati|Perlu Pemeriksaan|Data Belum Cukup","confidence":0,"observations":["..."],"caution":"...","next_steps":["..."]}',
      `Data tambahan: HST=${String(contextRecord.hst ?? "tidak diisi")}; tanah=${String(contextRecord.soil ?? "tidak diisi")}; pupuk=${String(contextRecord.fertilization ?? "tidak diisi")}; tanda=${symptoms.join(", ") || "tidak ada"}.`,
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Periksa foto tanaman cabai ini sesuai aturan di atas." },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
          ],
        },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content;
    if (rawContent === null || rawContent === undefined) {
      return json({ error: "Model tidak mengembalikan hasil pemeriksaan." }, 502);
    }

    const review = parseModelReview(rawContent);
    if (!review) {
      console.error("Cabeku AI parse error", { contentType: typeof rawContent });
      return json({ error: "AI merespons, tetapi format hasil tidak dapat dibaca." }, 502);
    }

    if (review.photo_quality === "poor") {
      review.status = "Data Belum Cukup";
      review.confidence = Math.min(review.confidence, 45);
      review.caution = "Foto belum cukup jelas untuk pemeriksaan visual yang bertanggung jawab. Ambil foto lebih terang dan fokus, serta tampilkan daun dan buah bila ada.";
      review.next_steps = [
        "Ambil foto ulang dengan cahaya cukup",
        "Tampilkan seluruh tanaman atau bagian bergejala",
        "Lengkapi data HST dan kondisi tanah/media",
      ];
    }

    return json({ ok: true, review });
  } catch (error) {
    console.error("Cabeku scan error", error);
    return json({ error: "Pemeriksaan foto gagal diproses. Coba lagi." }, 500);
  }
};

export const config = { path: "/api/cabeku-scan", method: "POST" };
