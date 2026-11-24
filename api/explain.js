// Fungsi serverless Vercel: meneruskan prompt ke Gemini.
// Kunci disimpan di environment variable GEMINI_API_KEY (jangan ditulis di file ini).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_PROMPT_CHARS = 4000;
const LIMIT_PER_IP = 10;            // panggilan
const WINDOW_MS = 60 * 60 * 1000;   // per jam
const hits = new Map();             // catatan per IP (di memori, reset saat fungsi baru jalan)

function allow(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT_PER_IP) {
    hits.set(ip, list);
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Layanan AI belum disiapkan. Hubungi pembuat aplikasi." });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (!allow(ip)) {
    return res.status(429).json({ error: "Batas penggunaan tercapai. Coba lagi beberapa menit lagi." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return res.status(400).json({ error: "Data perhitungan kosong." });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: "Data terlalu panjang." });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "Anda menjelaskan hasil hitungan harga dan margin dalam 3 sampai 5 kalimat bahasa Indonesia sederhana. Angka harus sama persis dengan data. Jangan mengubah angka, jangan menjanjikan hasil, dan jangan memakai sapaan jenis kelamin. Sebut skenario dengan nama yang sama seperti di data." }]
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
        }),
        signal: AbortSignal.timeout(25000)
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.error("gemini-error", r.status, JSON.stringify(data).slice(0, 800));
    if (!r.ok) {
      const status = r.status === 429 ? 429 : r.status === 503 ? 503 : 502;
      const msg = status === 429
        ? "Layanan AI sedang penuh. Coba lagi nanti."
        : "Gagal membuat penjelasan dari AI saat ini. Coba lagi.";
      return res.status(status).json({ error: msg });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) {
      return res.status(502).json({ error: "AI tidak memberi penjelasan. Coba lagi." });
    }
    return res.status(200).json({ text });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? "Waktu habis saat menunggu AI. Coba lagi." : "Gagal menghubungi layanan AI."
    });
  }
};
