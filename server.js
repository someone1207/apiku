const express = require("express");
const cors = require("cors");
const maker = require("mumaker"); // support textpro, photooxy, ephoto

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ============ GENERIC HANDLER ============ //
async function handleEffect(res, type, url, text) {
  try {
    if (!url) return res.status(400).json({ error: "❌ Param 'url' wajib diisi" });
    if (!text) return res.status(400).json({ error: "❌ Param 'text' wajib diisi" });

    let input = text;
    if (typeof text === "string" && text.includes("|")) {
      input = text.split("|").map(t => t.trim()).filter(Boolean);
    }

    let result;
    if (type === "textpro") result = await maker.textpro(url, input);
    if (type === "photooxy") result = await maker.photooxy(url, input);
    if (type === "ephoto") result = await maker.ephoto(url, input);

    if (!result || !result.image) {
      return res.status(500).json({ error: `❌ Gagal generate efek ${type}` });
    }

    return res.json({
      status: "success",
      service: type,
      input,
      url,
      result: result.image,
    });
  } catch (err) {
    console.error(`${type} error:`, err);
    return res.status(500).json({ error: `⚠️ Internal server error: ${err.message}` });
  }
}

// ============ ROUTES ============ //

// TextPro
app.get("/api/textpro", async (req, res) => {
  const { url, text } = req.query;
  return handleEffect(res, "textpro", url, text);
});

// PhotoOxy
app.get("/api/photooxy", async (req, res) => {
  const { url, text } = req.query;
  return handleEffect(res, "photooxy", url, text);
});

// Ephoto360
app.get("/api/ephoto", async (req, res) => {
  const { url, text } = req.query;
  return handleEffect(res, "ephoto", url, text);
});

// Root info
app.get("/", (req, res) => {
  res.json({
    status: "running",
    message: "✅ API untuk TextPro, PhotoOxy, Ephoto",
    endpoints: {
      textpro: "/api/textpro?url=<link>&text=teks1|teks2",
      photooxy: "/api/photooxy?url=<link>&text=teks",
      ephoto: "/api/ephoto?url=<link>&text=teks"
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server jalan di http://localhost:${PORT}`);
});
