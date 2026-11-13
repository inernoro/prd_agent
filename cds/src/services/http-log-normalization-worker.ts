import { parentPort } from 'node:worker_threads';
import { normalizeCapturedHttpLog, type CapturedHttpLog } from './http-log-store.js';

// Importing services for release validation must not start an actor or throw.
parentPort?.on('message', (message: { id: number; input: CapturedHttpLog }) => {
  try { parentPort!.postMessage({ id: message.id, record: normalizeCapturedHttpLog(message.input) }); }
  catch { parentPort!.postMessage({ id: message.id, error: 'normalization failed' }); }
});
