import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createBridgeRouter } from '../../src/routes/bridge.js';

interface TestResponse {
  status: number;
  body: any;
}

function fakeBridgeService() {
  return {
    heartbeat: () => {
      throw new Error('heartbeat should not be called while bridge is disabled');
    },
    submitResult: () => {
      throw new Error('submitResult should not be called while bridge is disabled');
    },
    isSessionActive: () => {
      throw new Error('isSessionActive should not be called while bridge is disabled');
    },
    startSession: () => {
      throw new Error('startSession should not be called while bridge is disabled');
    },
    getConnections: () => {
      throw new Error('getConnections should not be called while bridge is disabled');
    },
    isConnected: () => {
      throw new Error('isConnected should not be called while bridge is disabled');
    },
    getState: () => null,
    sendCommand: async () => {
      throw new Error('sendCommand should not be called while bridge is disabled');
    },
    addNavigateRequest: () => {
      throw new Error('addNavigateRequest should not be called while bridge is disabled');
    },
    getNavigateRequests: () => {
      throw new Error('getNavigateRequests should not be called while bridge is disabled');
    },
    dismissNavigateRequest: () => undefined,
    addHandshakeRequest: () => {
      throw new Error('addHandshakeRequest should not be called while bridge is disabled');
    },
    getPendingHandshakeRequests: () => {
      throw new Error('getPendingHandshakeRequests should not be called while bridge is disabled');
    },
    approveHandshake: () => null,
    rejectHandshake: () => null,
    getHandshakeStatus: () => null,
    endSession: () => undefined,
  };
}

async function withServer<T>(fn: (server: http.Server) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/bridge', createBridgeRouter({ bridgeService: fakeBridgeService() as any }));
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function request(server: http.Server, method: string, path: string, body?: unknown): Promise<TestResponse> {
  const addr = server.address() as { port: number };
  return await new Promise<TestResponse>((resolve, reject) => {
    const payload = body == null ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Bridge routes disabled by default', () => {
  const original = process.env.CDS_BRIDGE_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.CDS_BRIDGE_ENABLED;
    else process.env.CDS_BRIDGE_ENABLED = original;
  });

  it('returns inert widget polling responses without touching BridgeService', async () => {
    delete process.env.CDS_BRIDGE_ENABLED;
    await withServer(async (server) => {
      const check = await request(server, 'GET', '/api/bridge/check/branch-a');
      expect(check.status).toBe(200);
      expect(check.body).toMatchObject({ active: false, disabled: true, code: 'bridge_disabled' });

      const nav = await request(server, 'GET', '/api/bridge/navigate-requests/branch-a');
      expect(nav.status).toBe(200);
      expect(nav.body).toMatchObject({ requests: [], disabled: true });

      const heartbeat = await request(server, 'POST', '/api/bridge/heartbeat', { branchId: 'branch-a', state: {} });
      expect(heartbeat.status).toBe(200);
      expect(heartbeat.body).toMatchObject({ command: null, disabled: true });
    });
  });

  it('rejects agent activation while disabled', async () => {
    delete process.env.CDS_BRIDGE_ENABLED;
    await withServer(async (server) => {
      const res = await request(server, 'POST', '/api/bridge/start-session', { branchId: 'branch-a' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ disabled: true, code: 'bridge_disabled' });
    });
  });
});
