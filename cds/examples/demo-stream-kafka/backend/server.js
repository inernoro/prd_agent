// Demo backend: Express producer + Kafka consumer (kafkajs).
// POST /api/produce sends an event to a topic. A consumer subscribed to the
// same topic reads events into an in-memory list. GET /api/events returns
// them. This is a real produce -> broker -> consume round-trip.

import cors from 'cors';
import express from 'express';
import { Kafka, logLevel } from 'kafkajs';

const port = Number(process.env.PORT || 3000);
// KAFKA_BROKERS is a comma-separated broker list, e.g. "kafka:9092".
const brokers = (process.env.KAFKA_BROKERS || 'kafka:9092')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const TOPIC = 'demo.events';

const app = express();
app.use(cors());
app.use(express.json());

// broker 侧的客户端监听器是 SASL_PLAINTEXT/PLAIN（CDS 的基础设施认证门禁不再接受
// 裸 PLAINTEXT）。凭据从环境变量来；没配就退回无认证连接，这样把这份示例搬去别处
// 也还能跑，而不是直接连不上。
const saslUsername = (process.env.KAFKA_SASL_USERNAME || '').trim();
const saslPassword = (process.env.KAFKA_SASL_PASSWORD || '').trim();
const kafka = new Kafka({
  clientId: 'demo-stream-backend',
  brokers,
  ...(saslUsername && saslPassword
    ? { sasl: { mechanism: 'plain', username: saslUsername, password: saslPassword } }
    : {}),
  logLevel: logLevel.NOTHING,
  retry: { initialRetryTime: 1000, retries: 12 },
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'demo-stream-consumer' });

// Consumed events, newest first.
const events = [];
const MAX_KEEP = 200;
let brokerReady = false;

// Connect producer + consumer, create the topic, and start consuming.
// Kafka in KRaft mode takes a while to be ready; kafkajs retries internally,
// and we also retry the whole bootstrap a few times.
async function bootstrap(attempt = 1) {
  try {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: TOPIC, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
    await admin.disconnect();

    await producer.connect();

    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const text = message.value ? message.value.toString() : '';
        events.unshift({ text, at: new Date().toISOString() });
        if (events.length > MAX_KEEP) events.length = MAX_KEEP;
      },
    });

    brokerReady = true;
    console.log(`kafka connected (${brokers.join(',')}), consuming ${TOPIC}`);
  } catch (error) {
    brokerReady = false;
    const delay = Math.min(attempt * 2000, 12000);
    console.error(`kafka bootstrap failed (attempt ${attempt}): ${error.message}; retry in ${delay}ms`);
    setTimeout(() => bootstrap(attempt + 1), delay);
  }
}

app.get('/api/health', (_req, res) => {
  res.status(brokerReady ? 200 : 503).json({
    ok: brokerReady,
    service: 'stream-backend',
    broker: brokerReady ? 'connected' : 'connecting',
    brokers,
    topic: TOPIC,
    eventCount: events.length,
  });
});

// POST /api/produce — publish an event to the Kafka topic.
app.post('/api/produce', async (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  if (!brokerReady) {
    return res.status(503).json({ ok: false, error: 'broker not ready' });
  }
  try {
    await producer.send({ topic: TOPIC, messages: [{ value: text }] });
    res.status(202).json({ ok: true, produced: text });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// GET /api/events — events the consumer has read from the topic.
app.get('/api/events', (_req, res) => {
  res.json({ ok: true, count: events.length, events });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`stream-backend listening on ${port}`);
});

bootstrap();
