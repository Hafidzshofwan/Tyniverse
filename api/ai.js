const admin = require('firebase-admin');

// Model yang diizinkan (hemat biaya + cegah penyalahgunaan endpoint).
const ALLOWED_MODELS = new Set([
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen3-235b-a22b:free',
  'google/gemini-2.0-flash-exp:free',
  'openai/gpt-oss-120b:free',
  'openrouter/free'
]);
// Model cadangan yang paling andal: router yang selalu memilih model gratis yang sedang tersedia.
const FALLBACK_MODEL = 'openrouter/free';
const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324:free';

const SYSTEM_INSTRUCTION =
  'Anda adalah asisten penulisan untuk aplikasi Tinyverse, alat bantu edukasi klinis anak. ' +
  'Selalu tulis jawaban HANYA dalam Bahasa Indonesia baku yang benar, jelas, dan mudah dipahami. ' +
  'Jangan mencampur bahasa lain dan jangan menghasilkan kata yang tidak baku atau tidak bermakna. ' +
  'Jawaban harus ringkas, aman, dan selalu ingatkan bahwa keputusan klinis tetap oleh tenaga kesehatan ' +
  'profesional. Jangan membuat diagnosis pasti tanpa konteks klinis lengkap.';

function initAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diatur di Environment Variables.');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metode tidak diizinkan.' });
  }
  try {
    // 1) Wajib login: verifikasi Firebase ID token.
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Anda harus login.' });
    let decoded;
    try {
      decoded = await initAdmin().auth().verifyIdToken(match[1]);
    } catch (e) {
      return res.status(401).json({ error: 'Sesi login tidak valid. Silakan login ulang.' });
    }

    // 2) Validasi input.
    const body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
    const prompt = String(body.prompt || '').trim();
    let model = String(body.model || '');
    if (!ALLOWED_MODELS.has(model)) model = DEFAULT_MODEL;
    if (!prompt) return res.status(400).json({ error: 'Prompt kosong.' });
    if (prompt.length > 4000) return res.status(400).json({ error: 'Prompt terlalu panjang (maks 4000 karakter).' });

    // 3) Panggil OpenRouter dengan key rahasia (tidak pernah dikirim ke browser).
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENROUTER_API_KEY belum diatur.' });

    async function callModel(modelId) {
      const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tyniverse.vercel.app',
          'X-Title': 'TinyVerse'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1024
        })
      });
      const data = await orResp.json().catch(function () { return {}; });
      const text =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : '';
      return { ok: orResp.ok, data: data, text: text };
    }

    // Coba model pilihan; jika gagal/kosong (mis. penyedia gratis sedang penuh),
    // otomatis jatuh ke FALLBACK_MODEL yang selalu memilih model gratis tersedia.
    const tryOrder = [model];
    if (model !== FALLBACK_MODEL) tryOrder.push(FALLBACK_MODEL);
    let lastErr = 'Gagal memanggil model AI.';
    for (let i = 0; i < tryOrder.length; i++) {
      try {
        const r = await callModel(tryOrder[i]);
        if (r.ok && r.text && r.text.trim()) {
          return res.status(200).json({ text: r.text, model: tryOrder[i] });
        }
        lastErr = (r.data && r.data.error && r.data.error.message) || lastErr;
      } catch (e) {
        lastErr = (e && e.message) || lastErr;
      }
    }
    return res.status(502).json({ error: 'Model AI gratis sedang sibuk/penuh. Coba lagi beberapa saat. (' + lastErr + ')' });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Kesalahan server.' });
  }
};
