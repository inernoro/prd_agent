/**
 * Bridge Service — WebSocket hub for Page Agent Bridge connections.
 *
 * Manages per-branch WebSocket connections between browser-side Bridge Clients
 * (embedded in CDS Widget) and the CDS server. Provides REST-accessible state
 * and command relay for external agents (e.g., coding AI).
 *
 * Architecture:
 *   Browser Widget ←→ WebSocket ←→ BridgeService ←→ REST API ←→ Agent
 */

import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import type http from 'node:http';

// ── Protocol Types ──

export interface PageState {
  url: string;
  title: string;
  domTree: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  consoleErrors: string[];
  networkErrors: string[];
  timestamp: number;
}

export interface BridgeCommand {
  id: string;
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'evaluate' | 'snapshot';
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  success: boolean;
  error?: string;
  state: PageState;
}

export interface BridgeEvent {
  type: 'connected' | 'disconnected' | 'page-changed' | 'error';
  state?: PageState;
  error?: string;
}

export interface NavigateRequest {
  id: string;
  branchId: string;
  url: string;
  reason: string;
  createdAt: string;
}

interface BridgeConnection {
  branchId: string;
  ws: WebSocketLike;
  connectedAt: string;
  lastState: PageState | null;
  pendingCommands: Map<string, {
    resolve: (resp: BridgeResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

// ── WebSocket frame helpers (minimal RFC 6455 implementation) ──
// We avoid adding a `ws` dependency to CDS by implementing raw frame handling.

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5BB5C3CF4571';
const WS_OPCODE_TEXT = 0x1;
const WS_OPCODE_CLOSE = 0x8;
const WS_OPCODE_PING = 0x9;
const WS_OPCODE_PONG = 0xA;

function computeAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  const len = data.length;
  let headerLen: number;
  let header: Buffer;

  if (len < 126) {
    headerLen = 2;
    header = Buffer.alloc(headerLen);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    headerLen = 4;
    header = Buffer.alloc(headerLen);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    headerLen = 10;
    header = Buffer.alloc(headerLen);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, data]);
}

/**
 * Wraps a raw TCP socket into a minimal WebSocket-like interface.
 * Handles frame parsing, masking (client→server), ping/pong, and close.
 */
function wrapSocket(socket: Duplex, onMessage: (msg: string) => void, onClose: () => void): WebSocketLike {
  let readyState = 1; // OPEN
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0F;
      const masked = !!(secondByte & 0x80);
      let payloadLen = secondByte & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return; // wait for more data
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (buffer.length < totalLen) return; // wait for more data

      let payload = buffer.subarray(offset + maskLen, totalLen);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload); // copy before mutation
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }

      buffer = buffer.subarray(totalLen);

      if (opcode === WS_OPCODE_TEXT) {
        try { onMessage(payload.toString('utf-8')); } catch { /* ignore parse errors */ }
      } else if (opcode === WS_OPCODE_PING) {
        if (readyState === 1) {
          try { socket.write(encodeFrame(WS_OPCODE_PONG, payload)); } catch { /* ignore */ }
        }
      } else if (opcode === WS_OPCODE_CLOSE) {
        readyState = 3; // CLOSED
        try { socket.write(encodeFrame(WS_OPCODE_CLOSE, Buffer.alloc(0))); } catch { /* ignore */ }
        socket.end();
        onClose();
        return;
      }
    }
  });

  socket.on('close', () => {
    if (readyState !== 3) {
      readyState = 3;
      onClose();
    }
  });

  socket.on('error', () => {
    if (readyState !== 3) {
      readyState = 3;
      onClose();
    }
  });

  return {
    send(data: string) {
      if (readyState === 1) {
        try { socket.write(encodeFrame(WS_OPCODE_TEXT, data)); } catch { /* ignore */ }
      }
    },
    close(code?: number, _reason?: string) {
      if (readyState === 1) {
        readyState = 2; // CLOSING
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code || 1000, 0);
        try { socket.write(encodeFrame(WS_OPCODE_CLOSE, payload)); } catch { /* ignore */ }
        socket.end();
      }
    },
    get readyState() { return readyState; },
  };
}

// ── Bridge Service ──

const COMMAND_TIMEOUT = 15_000; // 15 seconds
const HEARTBEAT_INTERVAL = 15_000;

export class BridgeService {
  private connections = new Map<string, BridgeConnection>();
  private navigateRequests = new Map<string, NavigateRequest>();
  private onActivityCallback: ((branchId: string, action: string) => void) | null = null;

  /** Register a callback for activity tracking */
  onActivity(cb: (branchId: string, action: string) => void): void {
    this.onActivityCallback = cb;
  }

  /** Handle HTTP upgrade to WebSocket for bridge connections */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/bridge/ws') return false;

    const branchId = url.searchParams.get('branchId');
    if (!branchId) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return true;
    }

    // Validate WebSocket upgrade headers
    const upgradeHeader = req.headers['upgrade'];
    const wsKey = req.headers['sec-websocket-key'] as string | undefined;
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket' || !wsKey) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return true;
    }

    // Complete WebSocket handshake
    const acceptKey = computeAcceptKey(wsKey);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n',
    );

    // Write any head buffer
    if (head.length > 0) {
      socket.unshift(head);
    }

    // Close existing connection for this branch (replace)
    const existing = this.connections.get(branchId);
    if (existing) {
      this.cleanupConnection(branchId);
    }

    // Wrap socket
    const ws = wrapSocket(
      socket,
      (msg) => {
        console.log(`  [bridge] Message from ${branchId}: ${msg.slice(0, 200)}`);
        this.handleMessage(branchId, msg);
      },
      () => this.handleDisconnect(branchId),
    );

    // Debug: log socket events
    socket.on('error', (err) => {
      console.error(`  [bridge] Socket error for ${branchId}: ${(err as Error).message}`);
    });
    socket.on('close', () => {
      console.log(`  [bridge] Socket close event for ${branchId}`);
    });

    // Setup heartbeat (ping every 15s to keep connection alive)
    const heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        console.log(`  [bridge] Sending ping to ${branchId}`);
        try { socket.write(encodeFrame(WS_OPCODE_PING, Buffer.alloc(0))); } catch (e) {
          console.error(`  [bridge] Ping failed: ${(e as Error).message}`);
        }
      }
    }, HEARTBEAT_INTERVAL);

    const conn: BridgeConnection = {
      branchId,
      ws,
      connectedAt: new Date().toISOString(),
      lastState: null,
      pendingCommands: new Map(),
      heartbeatTimer,
    };

    this.connections.set(branchId, conn);
    console.log(`  [bridge] Connected: ${branchId}`);
    this.onActivityCallback?.(branchId, 'Bridge 已连接');

    // Request initial snapshot after DOM stabilizes
    setTimeout(() => {
      console.log(`  [bridge] Sending initial snapshot request to ${branchId}`);
      this.sendCommand(branchId, { id: crypto.randomBytes(4).toString('hex'), action: 'snapshot', params: {} })
        .catch(() => { /* ignore initial snapshot failure */ });
    }, 500);

    return true;
  }

  private handleMessage(branchId: string, raw: string): void {
    const conn = this.connections.get(branchId);
    if (!conn) return;

    try {
      const msg = JSON.parse(raw);

      // Response to a pending command
      if (msg.id && conn.pendingCommands.has(msg.id)) {
        const pending = conn.pendingCommands.get(msg.id)!;
        clearTimeout(pending.timer);
        conn.pendingCommands.delete(msg.id);

        if (msg.state) conn.lastState = msg.state;
        pending.resolve(msg as BridgeResponse);
        return;
      }

      // Autonomous event from widget
      if (msg.type) {
        const event = msg as BridgeEvent;
        if (event.state) conn.lastState = event.state;
        if (event.type === 'page-changed') {
          this.onActivityCallback?.(branchId, '页面已变化');
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private handleDisconnect(branchId: string): void {
    this.cleanupConnection(branchId);
    console.log(`  [bridge] Disconnected: ${branchId}`);
    this.onActivityCallback?.(branchId, 'Bridge 已断开');
  }

  private cleanupConnection(branchId: string): void {
    const conn = this.connections.get(branchId);
    if (!conn) return;

    clearInterval(conn.heartbeatTimer);
    for (const [, pending] of conn.pendingCommands) {
      clearTimeout(pending.timer);
      pending.resolve({
        id: '',
        success: false,
        error: 'connection closed',
        state: conn.lastState || emptyState(),
      });
    }
    conn.pendingCommands.clear();

    if (conn.ws.readyState === 1) {
      conn.ws.close(1000);
    }

    this.connections.delete(branchId);
  }

  /** Send a command to the widget and wait for response */
  async sendCommand(branchId: string, command: BridgeCommand): Promise<BridgeResponse> {
    const conn = this.connections.get(branchId);
    if (!conn || conn.ws.readyState !== 1) {
      return { id: command.id, success: false, error: 'no connection', state: emptyState() };
    }

    return new Promise<BridgeResponse>((resolve) => {
      const timer = setTimeout(() => {
        conn.pendingCommands.delete(command.id);
        resolve({
          id: command.id,
          success: false,
          error: 'timeout',
          state: conn.lastState || emptyState(),
        });
      }, COMMAND_TIMEOUT);

      conn.pendingCommands.set(command.id, { resolve, timer });
      conn.ws.send(JSON.stringify(command));
    });
  }

  /** Get the last known state for a branch */
  getState(branchId: string): PageState | null {
    return this.connections.get(branchId)?.lastState ?? null;
  }

  /** Check if a branch has an active bridge connection */
  isConnected(branchId: string): boolean {
    const conn = this.connections.get(branchId);
    return !!conn && conn.ws.readyState === 1;
  }

  /** List all active connections */
  getConnections(): Array<{ branchId: string; url: string; connectedAt: string }> {
    const result: Array<{ branchId: string; url: string; connectedAt: string }> = [];
    for (const [branchId, conn] of this.connections) {
      if (conn.ws.readyState === 1) {
        result.push({
          branchId,
          url: conn.lastState?.url || '',
          connectedAt: conn.connectedAt,
        });
      }
    }
    return result;
  }

  /** Store a navigate request for the widget to pick up */
  addNavigateRequest(branchId: string, url: string, reason: string): NavigateRequest {
    const req: NavigateRequest = {
      id: crypto.randomBytes(8).toString('hex'),
      branchId,
      url,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.navigateRequests.set(req.id, req);

    // Auto-expire after 60 seconds
    setTimeout(() => {
      this.navigateRequests.delete(req.id);
    }, 60_000);

    return req;
  }

  /** Get pending navigate requests for a branch */
  getNavigateRequests(branchId: string): NavigateRequest[] {
    return Array.from(this.navigateRequests.values())
      .filter(r => r.branchId === branchId);
  }

  /** Dismiss a navigate request */
  dismissNavigateRequest(id: string): void {
    this.navigateRequests.delete(id);
  }
}

function emptyState(): PageState {
  return {
    url: '',
    title: '',
    domTree: '',
    viewport: { width: 0, height: 0 },
    scrollPosition: { x: 0, y: 0 },
    consoleErrors: [],
    networkErrors: [],
    timestamp: 0,
  };
}
