import express from "express";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 3000;
const mongoUrl = process.env.MONGODB_URL || "mongodb://mongodb:27017/app";

let collection = null;

async function connectMongo() {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  collection = client.db().collection("visits");
  console.log("[tutorial-03-backend] mongo connected");
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

connectMongo().catch((e) => {
  console.error("[tutorial-03-backend] mongo connect failed:", e.message);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[tutorial-03-backend] listening on ${port}`);
});
