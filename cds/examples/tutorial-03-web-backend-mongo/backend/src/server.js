import express from "express";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 3000;
const mongoUrl = process.env.MONGODB_URL || "mongodb://mongodb:27017/app";

let collection = null;

// depends_on 短语法不会等 mongodb healthy 就启动本服务，首连可能撞上 mongo 仍在初始化。
// 用退避重试代替一次性连接，避免 collection 永久为 null 导致 /ready 持续 503。
async function connectMongo() {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 3000 });
      await client.connect();
      collection = client.db().collection("visits");
      console.log("[tutorial-03-backend] mongo connected");
      return;
    } catch (e) {
      const waitMs = Math.min(1000 * attempt, 5000);
      console.error(`[tutorial-03-backend] mongo connect failed (attempt ${attempt}): ${e.message}; retry in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// 就绪探针：mongo 连上才算 ready。
app.get("/ready", (_req, res) => {
  if (collection) res.json({ ok: true });
  else res.status(503).json({ ok: false, reason: "mongo not ready" });
});

// 每次调用写一条记录并返回累计访问数，证明读写 mongo 通路。
app.get("/api/visit", async (_req, res) => {
  if (!collection) return res.status(503).json({ ok: false, reason: "mongo not ready" });
  await collection.insertOne({ at: new Date() });
  const count = await collection.countDocuments();
  res.json({ ok: true, visits: count });
});

connectMongo();

app.listen(port, "0.0.0.0", () => {
  console.log(`[tutorial-03-backend] listening on ${port}`);
});
