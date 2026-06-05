// Demo backend: Express + NATS pub/sub (nats).
// POST /api/pub publishes a message on a subject. A subscriber on the same
// subject collects messages into an in-memory list. GET /api/sub returns
// them. Real publish -> NATS -> subscribe round-trip, not a stub.

import cors from 'cors';
import express from 'express';
import { connect, StringCodec } from 'nats';

const port = Number(process.env.PORT || 3000);
const natsUrl = process.env.NATS_URL || 'nats://nats:4222';
const SUBJECT = 'demo.events';
const sc = StringCodec();

const app = express();
app.use(cors());
app.use(express.json());

// Received messages, newest first.
const received = [];
const MAX_KEEP = 200;

let nc = null;
let brokerReady = false;

// Connect to NATS and start a subscription. nats.connect already retries
// (reconnect: true); we additionally retry the initial connect.
async function bootstrap(attempt = 1) {
  try {
    nc = await connect({ servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 });
    brokerReady = true;
    console.log(`nats connected (${natsUrl}), subscribing ${SUBJECT}`);

    const sub = nc.subscribe(SUBJECT);
    (async () => {
      for await (const msg of sub) {
        received.unshift({ text: sc.decode(msg.data), at: new Date().toISOString() });
        if (received.length > MAX_KEEP) received.length = MAX_KEEP;
      }
    })();

    nc.closed().then(() => {
      brokerReady = false;
    });
  } catch (error) {
    brokerReady = false;
    const delay = Math.min(attempt * 2000, 10000);
    console.error(`nats connect failed (attempt ${attempt}): ${error.message}; retry in ${delay}ms`);
    setTimeout(() => bootstrap(attempt + 1), delay);
  }
}

app.get('/api/health', (_req, res) => {
  res.status(brokerReady ? 200 : 503).json({
    ok: brokerReady,
    service: 'events-backend',
    broker: brokerReady ? 'connected' : 'connecting',
    subject: SUBJECT,
    receivedCount: received.length,
  });
});

// POST /api/pub — publish a message on the NATS subject.
app.post('/api/pub', (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  if (!brokerReady || !nc) {
    return res.status(503).json({ ok: false, error: 'broker not ready' });
  }
  try {
    nc.publish(SUBJECT, sc.encode(text));
    res.status(202).json({ ok: true, published: text });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// GET /api/sub — messages the subscriber has received.
app.get('/api/sub', (_req, res) => {
  res.json({ ok: true, count: received.length, messages: received });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`events-backend listening on ${port}`);
});

bootstrap();
