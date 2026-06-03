// Demo backend: Express producer + RabbitMQ consumer (amqplib).
// POST /api/publish enqueues a message onto a durable queue. A long-lived
// consumer drains the queue and appends each message to an in-memory list.
// GET /api/messages returns what the consumer has processed. This proves a
// real round-trip through the broker, not a stub.

import cors from 'cors';
import express from 'express';
import amqp from 'amqplib';

const port = Number(process.env.PORT || 3000);
const amqpUrl = process.env.RABBITMQ_URL;
const QUEUE = 'demo.messages';

const app = express();
app.use(cors());
app.use(express.json());

// Processed messages live here (newest first). A real app would persist
// these; for a demo an in-memory ring is enough to prove consumption.
const processed = [];
const MAX_KEEP = 200;

let connection = null;
let publishChannel = null;
let brokerReady = false;

// Connect once, assert the queue, and start a consumer. Retries on failure
// so the backend can boot before RabbitMQ finishes its (slow) startup.
async function connectWithRetry(attempt = 1) {
  try {
    connection = await amqp.connect(amqpUrl);
    connection.on('error', () => {
      brokerReady = false;
    });
    connection.on('close', () => {
      brokerReady = false;
      setTimeout(() => connectWithRetry(1), 2000);
    });

    publishChannel = await connection.createChannel();
    await publishChannel.assertQueue(QUEUE, { durable: true });

    const consumeChannel = await connection.createChannel();
    await consumeChannel.assertQueue(QUEUE, { durable: true });
    await consumeChannel.consume(QUEUE, (msg) => {
      if (!msg) return;
      const text = msg.content.toString();
      processed.unshift({ text, at: new Date().toISOString() });
      if (processed.length > MAX_KEEP) processed.length = MAX_KEEP;
      consumeChannel.ack(msg);
    });

    brokerReady = true;
    console.log('rabbitmq connected, consumer started');
  } catch (error) {
    brokerReady = false;
    const delay = Math.min(attempt * 2000, 10000);
    console.error(`rabbitmq connect failed (attempt ${attempt}): ${error.message}; retry in ${delay}ms`);
    setTimeout(() => connectWithRetry(attempt + 1), delay);
  }
}

app.get('/api/health', (_req, res) => {
  res.status(brokerReady ? 200 : 503).json({
    ok: brokerReady,
    service: 'queue-backend',
    broker: brokerReady ? 'connected' : 'connecting',
    processedCount: processed.length,
  });
});

// POST /api/publish — enqueue a message onto RabbitMQ.
app.post('/api/publish', (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  if (!brokerReady || !publishChannel) {
    return res.status(503).json({ ok: false, error: 'broker not ready' });
  }
  try {
    publishChannel.sendToQueue(QUEUE, Buffer.from(text), { persistent: true });
    res.status(202).json({ ok: true, queued: text });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// GET /api/messages — messages the consumer has processed off the queue.
app.get('/api/messages', (_req, res) => {
  res.json({ ok: true, count: processed.length, messages: processed });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`queue-backend listening on ${port}`);
});

connectWithRetry();
