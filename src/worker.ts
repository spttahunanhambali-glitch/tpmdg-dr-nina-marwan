interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
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
const ALLOWED_STATUS = new Set(["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function validateImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 30 || value.length > MAX_BASE64_CHARS) return false;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  return Boolean(match && ALLOWED_MIME.has(match[1]));
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

function sanitizeList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLength)).filter(Boolean).slice(0, max);
}

function sanitizeReview(value: unknown) {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rawStatus = typeof input.status === "string" ? input.status : "Data Belum Cukup";
  const rawQuality = typeof input.photo_quality === "string" ? input.photo_quality : "poor";
  return {
    photo_quality: rawQuality === "good" || rawQuality === "fair" || rawQuality === "poor" ? rawQuality : "poor",
    status: ALLOWED_STATUS.has(rawStatus) ? rawStatus : "Data Belum Cukup",
    confidence: clampConfidence(input.confidence),
    observations: sanitizeList(input.observations, 6, 220),
    caution: typeof input.caution === "string"
      ? input.caution.trim().slice(0, 500)
      : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis penyakit.",
    next_steps: sanitizeList(input.next_steps, 5, 220),
  };
}

function buildPrompt(body: ScanBody): string {
  const context = body.context && typeof body.context === "object" ? body.context : {};
  const symptoms = Array.isArray(context.symptoms)
    ? context.symptoms.filter((x): x is string => typeof x === "string").slice(0, 10)
    : [];
  return [
    "Anda adalah Cabeku, modul pemeriksaan visual awal tanaman cabai untuk petani Indonesia.",
    "Amati foto secara konservatif dan hanya tuliskan hal yang benar-benar terlihat.",
    "Jangan mendiagnosis penyakit, jangan menyebut patogen sebagai kepastian, dan jangan memberi dosis pupuk atau pestisida.",
    "Gunakan tepat satu status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
    "Gunakan Data Belum Cukup bila foto buram, gelap, objek tidak jelas, atau bagian penting tanaman tidak terlihat.",
    "Perhatikan warna daun, bentuk daun, layu, bercak, kerusakan buah, kondisi tajuk, dan kualitas foto.",
    "Kembalikan JSON saja: {\"photo_quality\":\"good|fair|poor\",\"status\":\"Sehat|Perlu Diamati|Perlu Pemeriksaan|Data Belum Cukup\",\"confidence\":0,\"observations\":[\"...\"],\"caution\":\"...\",\"next_steps\":[\"...\"]}",
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
  if (!validateImageDataUrl(body.imageDataUrl)) return json({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP." }, 400);
  try {
    const result = await env.AI.run(MODEL, {
      prompt: buildPrompt(body),
      image: body.imageDataUrl,
      max_tokens: 700,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
    const candidate = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const raw = typeof result === "string" ? result : typeof candidate.response === "string" ? candidate.response : typeof candidate.result === "string" ? candidate.result : "";
    if (!raw) return json({ error: "Model tidak mengembalikan hasil." }, 502);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return json({ error: "Hasil AI tidak berbentuk JSON yang valid." }, 502); }
    const review = sanitizeReview(parsed);
    if (review.photo_quality === "poor") {
      review.status = "Data Belum Cukup";
      review.confidence = Math.min(review.confidence, 45);
      review.caution = "Foto belum cukup jelas untuk pemeriksaan visual yang bertanggung jawab.";
      review.next_steps = ["Ambil foto dengan cahaya cukup dan fokus", "Tampilkan seluruh tanaman atau bagian bergejala", "Lengkapi HST dan kondisi tanah/media"];
    }
    return json({ ok: true, review });
  } catch (error) {
    console.error("Cabeku Cloudflare AI scan error", error);
    return json({ error: "Pemeriksaan foto gagal diproses. Coba lagi." }, 500);
  }
}

const CABEKU_BRIDGE = String.raw`<script>
(() => {
  "use strict";
  const scanButton = document.querySelector("#scanBtn");
  const photoInput = document.querySelector("#photo");
  if (!scanButton || !photoInput) return;

  const statusClass = {
    "Sehat": "b-ok",
    "Perlu Diamati": "b-warn",
    "Perlu Pemeriksaan": "b-risk",
    "Data Belum Cukup": "b-data"
  };

  const setText = (id, text) => { const el = document.querySelector(id); if (el) el.textContent = text; };
  const addItem = (title, text) => {
    const list = document.querySelector("#resultList");
    if (!list) return;
    const item = document.createElement("div"); item.className = "result-item";
    const b = document.createElement("b"); b.textContent = title;
    const s = document.createElement("span"); s.textContent = text;
    item.append(b, s); list.append(item);
  };
  const setBadge = (status) => {
    const badge = document.querySelector("#badge");
    if (!badge) return;
    badge.className = "badge " + (statusClass[status] || "b-data");
    badge.textContent = status.toUpperCase();
    badge.style.display = "inline-flex";
  };
  const compressImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas tidak tersedia."));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Foto tidak dapat dibaca.")); };
    img.src = url;
  });

  scanButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const file = photoInput.files && photoInput.files[0];
    if (!file) { window.alert("Silakan pilih foto tanaman terlebih dahulu."); return; }

    scanButton.disabled = true;
    const originalLabel = scanButton.textContent || "Periksa kondisi tanaman";
    scanButton.textContent = "Menganalisis foto…";
    setText("#result-heading", "Sedang diperiksa");
    setText("#summary", "Cabeku sedang membaca kondisi visual foto. Jangan mengambil tindakan hanya dari hasil AI ini.");
    setText("#nextStep", "Menyiapkan hasil pemeriksaan visual…");

    try {
      const imageDataUrl = await compressImage(file);
      const symptoms = [...document.querySelectorAll(".check input:checked")].map((el) => el.value);
      const response = await fetch("/api/cabeku-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl,
          context: {
            hst: document.querySelector("#hst")?.value || null,
            soil: document.querySelector("#soil")?.value || null,
            fertilization: document.querySelector("#fert")?.value || null,
            symptoms
          }
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.review) throw new Error(payload.error || "Pemeriksaan gagal.");

      const review = payload.review;
      const list = document.querySelector("#resultList");
      if (list) list.replaceChildren();
      setText("#result-heading", review.status);
      setBadge(review.status);
      setText("#summary", review.caution || "Hasil pemeriksaan visual awal.");
      const scoreBar = document.querySelector("#scoreBar");
      const confidence = Math.max(0, Math.min(100, Number(review.confidence) || 0));
      if (scoreBar) scoreBar.style.width = confidence + "%";
      setText("#completenessText", "Foto AI " + confidence + "%");
      addItem("Kualitas foto", review.photo_quality);
      (review.observations || []).forEach((item) => addItem("Observasi visual", item));
      if (!(review.observations || []).length) addItem("Observasi visual", "Tidak ada observasi yang cukup kuat untuk dicatat.");
      (review.next_steps || []).forEach((item) => addItem("Langkah berikutnya", item));
      setText("#nextStep", review.next_steps?.[0] || "Lanjutkan pemantauan dan bandingkan dengan data budidaya serta SOP resmi.");
      scanButton.textContent = "Periksa ulang foto";
    } catch (error) {
      setText("#result-heading", "Pemeriksaan gagal");
      setText("#summary", error instanceof Error ? error.message : "Pemeriksaan foto gagal diproses. Coba lagi.");
      setText("#nextStep", "Periksa koneksi lalu coba kembali dengan foto yang lebih terang dan fokus.");
    } finally {
      scanButton.disabled = false;
      if (scanButton.textContent === "Menganalisis foto…") scanButton.textContent = originalLabel;
    }
  }, { capture: true });
})();
</script>`;

async function serveCabeku(request: Request, env: Env): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(request);
  if (!assetResponse.ok) return assetResponse;
  return new HTMLRewriter()
    .on("body", { end(element) { element.before(CABEKU_BRIDGE, { html: true }); } })
    .transform(assetResponse);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/cabeku-scan") return scanImage(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "API endpoint tidak ditemukan." }, 404);
    if (url.pathname === "/cabeku/" || url.pathname === "/cabeku") return serveCabeku(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
