import amqp from 'amqplib';
import cors from 'cors';
import express from 'express';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

async function checkMysql() {
  const url = process.env.MYSQL_URL;
  if (!url) return { ok: false, error: 'MYSQL_URL missing' };
  const connection = await mysql.createConnection(url);
  try {
    const [rows] = await connection.query('SELECT COUNT(*) AS count FROM smoke_checks');
    return { ok: true, rows };
  } finally {
    await connection.end();
  }
}

async function checkRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, error: 'REDIS_URL missing' };
  const client = createClient({ url });
  await client.connect();
  try {
    await client.set('cds:smoke', 'redis-ready', { EX: 60 });
    const value = await client.get('cds:smoke');
    return { ok: value === 'redis-ready', value };
  } finally {
    await client.quit();
  }
}

async function checkRabbitMq() {
  const url = process.env.RABBITMQ_URL;
  if (!url) return { ok: false, error: 'RABBITMQ_URL missing' };
  const connection = await amqp.connect(url);
  try {
    const channel = await connection.createChannel();
    try {
      const queue = 'cds.smoke';
      await channel.assertQueue(queue, { durable: false });
      await channel.sendToQueue(queue, Buffer.from('rabbitmq-ready'));
      const message = await channel.get(queue, { noAck: true });
      return { ok: message?.content.toString() === 'rabbitmq-ready' };
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
}

async function safe(label, fn) {
  try {
    return { label, ...(await fn()) };
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

app.get('/health', async (_req, res) => {
  const checks = await Promise.all([
    safe('mysql', checkMysql),
    safe('redis', checkRedis),
    safe('rabbitmq', checkRabbitMq),
  ]);
  const ok = checks.every((check) => check.ok);
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'backend',
    checks,
  });
});

app.get('/api/health', async (req, res) => {
  req.url = '/health';
  app.handle(req, res);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`CDS fullstack smoke backend listening on ${port}`);
});
