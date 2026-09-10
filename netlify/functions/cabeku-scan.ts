import OpenAI from "openai";

type ScanRequest = {
  imageDataUrl?: unknown;
  context?: {
    hst?: unknown;
    soil?: unknown;
    fertilization?: unknown;
    symptoms?: unknown;
  };
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
const ALLOWED_STATUS = new Set([
  "Sehat",
  "Perlu Diamati",
  "Perlu Pemeriksaan",
  "Data Belum Cukup",
]);

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
  if (!match) return false;
  const mime = match[1];
  const base64 = match[2];
  if (!ALLOWED_MIME.has(mime)) return false;
  const estimatedBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  return estimatedBytes > 0 && estimatedBytes <= MAX_IMAGE_BYTES;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sanitizeReview(value: unknown): VisualReview {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const quality = input.photo_quality === "good" || input.photo_quality === "fair" || input.photo_quality === "poor"
    ? input.photo_quality
    : "poor";
  const rawStatus = typeof input.status === "string" ? input.status : "Data Belum Cukup";
  const status = ALLOWED_STATUS.has(rawStatus) ? (rawStatus as VisualReview["status"]) : "Data Belum Cukup";
  const observations = Array.isArray(input.observations)
    ? input.observations.filter((item): item is string => typeof item === "string").slice(0, 6)
    : [];
  const nextSteps = Array.isArray(input.next_steps)
    ? input.next_steps.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  const caution = typeof input.caution === "string" ? input.caution.slice(0, 500) : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis.";

  return {
    photo_quality: quality,
    status,
    confidence: clampConfidence(input.confidence),
    observations,
    caution,
    next_steps: nextSteps,
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json()) as ScanRequest;
    const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";

    if (!isValidDataUrl(imageDataUrl)) {
      return json({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP maksimal 5 MB setelah kompresi." }, 400);
    }

    const context = body.context && typeof body.context === "object" ? body.context : {};
    const symptoms = Array.isArray((context as { symptoms?: unknown }).symptoms)
      ? ((context as { symptoms: unknown[] }).symptoms).filter((item): item is string => typeof item === "string").slice(0, 10)
      : [];

    const openai = new OpenAI();
    const prompt = [
      "Anda adalah modul pemeriksaan visual awal untuk aplikasi budidaya tanaman cabai di Indonesia.",
      "Tugas Anda hanya mengamati foto. Jangan menegakkan diagnosis penyakit, jangan menyebut patogen secara pasti, jangan memberi dosis pupuk, pestisida, fungisida, insektisida, atau bahan kimia.",
      "Gunakan empat status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
      "Pilih Data Belum Cukup bila tanaman terlalu kecil, objek tidak jelas, gambar buram/gelap, atau bagian penting tanaman tidak terlihat.",
      "Observasi harus berbasis apa yang terlihat: warna daun, bentuk daun, layu, bercak, kerusakan buah, kondisi tajuk, dan kualitas foto.",
      "Jangan menebak informasi yang tidak terlihat.",
      "Kembalikan JSON valid saja dengan bentuk:",
      '{"photo_quality":"good|fair|poor","status":"Sehat|Perlu Diamati|Perlu Pemeriksaan|Data Belum Cukup","confidence":0,"observations":["..."],"caution":"...","next_steps":["..."]}',
      `Data tambahan dari pengguna: HST=${String((context as Record<string, unknown>).hst ?? "tidak diisi")}; tanah=${String((context as Record<string, unknown>).soil ?? "tidak diisi")}; pupuk=${String((context as Record<string, unknown>).fertilization ?? "tidak diisi")}; tanda yang dicentang=${symptoms.join(", ") || "tidak ada"}.`,
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Periksa foto tanaman cabai ini sesuai aturan di atas." },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      return json({ error: "Model tidak mengembalikan hasil pemeriksaan." }, 502);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "Format hasil AI tidak valid." }, 502);
    }

    const review = sanitizeReview(parsed);
    if (review.photo_quality === "poor") {
      review.status = "Data Belum Cukup";
      review.confidence = Math.min(review.confidence, 45);
      review.caution = "Foto belum cukup jelas untuk pemeriksaan visual yang bertanggung jawab. Ambil foto lebih terang, fokus, dan tampilkan daun serta buah bila ada.";
      review.next_steps = ["Ambil foto ulang dengan cahaya cukup", "Tampilkan seluruh tanaman atau bagian bergejala", "Lengkapi data HST dan kondisi tanah/media"];
    }

    return json({ ok: true, review });
  } catch (error) {
    console.error("Cabeku scan error", error);
    return json({ error: "Pemeriksaan foto gagal diproses. Coba lagi." }, 500);
  }
};

export const config = {
  path: "/api/cabeku-scan",
  method: ["POST"],
};
