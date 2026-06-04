// Demo backend: Express + PostgreSQL (pg) + Redis.
// Proves real connectivity: reads/writes the `items` table in Postgres,
// and increments a visit counter key in Redis. No stubs.

import cors from 'cors';
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';

const { Pool } = pg;

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const app = express();
app.use(cors());
app.use(express.json());

// One shared Postgres pool for the process. The pool lazily connects on
// first query, so the server can boot even before Postgres finishes its
// init.sql; the first /api/items call will then succeed.
const pool = new Pool({ connectionString: databaseUrl });

// Redis client is connected lazily and reused. A small helper guarantees a
// live connection before each command.
const redis = createClient({ url: redisUrl });
redis.on('error', (err) => console.error('[redis] client error:', err.message));
let redisReady = false;
async function ensureRedis() {
  if (!redisReady) {
    await redis.connect();
    redisReady = true;
  }
  return redis;
}

// GET /api/health — reports live connectivity to both Postgres and Redis.
app.get('/api/health', async (_req, res) => {
  const checks = {};
  try {
    const r = await pool.query('SELECT 1 AS ok');
    checks.postgres = { ok: r.rows[0].ok === 1 };
  } catch (error) {
    checks.postgres = { ok: false, error: String(error.message || error) };
  }
  try {
    const client = await ensureRedis();
    const pong = await client.ping();
    checks.redis = { ok: pong === 'PONG' };
  } catch (error) {
    checks.redis = { ok: false, error: String(error.message || error) };
  }
  const ok = checks.postgres.ok && checks.redis.ok;
  res.status(ok ? 200 : 503).json({ ok, service: 'admin-backend', checks });
});

// GET /api/items — list rows from Postgres (seeded by init.sql).
app.get('/api/items', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, status, created_at FROM items ORDER BY id DESC'
    );
    res.json({ ok: true, items: r.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// POST /api/items — insert a row into Postgres and return it.
app.post('/api/items', async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const status = (req.body && req.body.status ? String(req.body.status) : 'active').trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }
  try {
    const r = await pool.query(
      'INSERT INTO items (name, status) VALUES ($1, $2) RETURNING id, name, status, created_at',
      [name, status]
    );
    res.status(201).json({ ok: true, item: r.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// GET /api/visits — increment a counter in Redis and return the new value.
app.get('/api/visits', async (_req, res) => {
  try {
    const client = await ensureRedis();
    const visits = await client.incr('admin:visits');
    res.json({ ok: true, visits });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`admin-backend listening on ${port}`);
});
