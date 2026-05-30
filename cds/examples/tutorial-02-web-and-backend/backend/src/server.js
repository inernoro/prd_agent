import express from "express";

const app = express();
const port = process.env.PORT || 3000;

// CDS 就绪探针打这个端点。
app.get("/ready", (_req, res) => res.json({ ok: true }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tutorial-02-backend", time: new Date().toISOString() });
});

app.get("/api/hello", (req, res) => {
  const name = String(req.query.name || "world");
  res.json({ message: `hello, ${name}` });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[tutorial-02-backend] listening on ${port}`);
});
