/**
 * Bridge Service — HTTP polling hub for Page Agent Bridge.
 *
 * Uses simple HTTP polling instead of WebSocket to avoid complexity of
 * proxying WebSocket through Cloudflare → Nginx → Worker → Master chain.
 * The CDS Widget already has a proven HTTP channel (/_cds/api/*).
 *
 * Architecture:
 *   Browser Widget ←→ HTTP Polling ←→ BridgeService ←→ REST API ←→ Agent
 *
 * Widget polls every 2s:
 *   GET  /api/bridge/poll/:branchId  → returns pending command (if any)
 *   POST /api/bridge/heartbeat       → registers/refreshes connection + uploads state
 *   POST /api/bridge/result          → returns command execution result
 *
 * Agent calls:
 *   GET  /api/bridge/connections     → list active connections
 *   GET  /api/bridge/state/:branchId → read latest page state
 *   POST /api/bridge/command/:branchId → queue command, wait for result
 *   POST /api/bridge/navigate-request → request user to open a page
 */

import crypto from 'node:crypto';

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
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'spa-navigate' | 'evaluate' | 'snapshot';
  params: Record<string, unknown>;
  /** Human-readable description shown in the operation panel (e.g. "点击「登录」按钮") */
  description?: string;
}

export interface BridgeResponse {
  id: string;
  success: boolean;
  error?: string;
  data?: string;
  state: PageState;
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
  connectedAt: string;
  lastHeartbeat: number;
  lastState: PageState | null;
  /** Pending commands waiting to be picked up by widget (FIFO queue) */
  pendingCommands: BridgeCommand[];
  /** Resolvers waiting for command result from widget */
  pendingResolvers: Map<string, {
    resolve: (resp: BridgeResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

// ── Bridge Service ──

const COMMAND_TIMEOUT = 15_000;
const CONNECTION_TTL = 20_000; // connection considered dead if no heartbeat for 20s (widget polls every 5s)

export class BridgeService {
  private connections = new Map<string, BridgeConnection>();
  private navigateRequests = new Map<string, NavigateRequest>();
  private activeSessions = new Set<string>(); // branches with active AI sessions
  private onActivityCallback: ((branchId: string, action: string) => void) | null = null;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically clean up dead connections (no heartbeat for 15s)
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [branchId, conn] of this.connections) {
        if (now - conn.lastHeartbeat > CONNECTION_TTL) {
          console.log(`  [bridge] Connection expired: ${branchId} (no heartbeat for ${Math.round((now - conn.lastHeartbeat) / 1000)}s)`);
          this.cleanupConnection(branchId);
        }
      }
    }, 5_000);
  }

  /** Register a callback for activity tracking */
  onActivity(cb: (branchId: string, action: string) => void): void {
    this.onActivityCallback = cb;
  }

  /** Widget heartbeat — registers or refreshes connection, uploads current state */
  heartbeat(branchId: string, state: PageState | null): { command: BridgeCommand | null } {
    let conn = this.connections.get(branchId);
    const isNew = !conn;

    if (!conn) {
      conn = {
        branchId,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: Date.now(),
        lastState: state,
        pendingCommands: [],
        pendingResolvers: new Map(),
      };
      this.connections.set(branchId, conn);
      console.log(`  [bridge] Connected: ${branchId}`);
      this.onActivityCallback?.(branchId, 'Bridge 已连接');
    } else {
      conn.lastHeartbeat = Date.now();
      if (state) conn.lastState = state;
    }

    // Return next pending command (FIFO)
    const cmd = conn.pendingCommands.length > 0 ? conn.pendingCommands.shift()! : null;

    // If new connection and no queued command, request initial snapshot
    if (isNew && !cmd) {
      return { command: { id: crypto.randomBytes(4).toString('hex'), action: 'snapshot', params: {} } };
    }

    return { command: cmd || null };
  }

  /** Widget submits command execution result */
  submitResult(branchId: string, result: BridgeResponse): void {
    const conn = this.connections.get(branchId);
    if (!conn) return;

    // Update state
    if (result.state) conn.lastState = result.state;
    conn.lastHeartbeat = Date.now();

    // Resolve pending promise
    const pending = conn.pendingResolvers.get(result.id);
    if (pending) {
      clearTimeout(pending.timer);
      conn.pendingResolvers.delete(result.id);
      pending.resolve(result);
    }
  }

  /** Long-poll: peek and shift the next command without creating a new connection */
  pollCommand(branchId: string): BridgeCommand | null {
    const conn = this.connections.get(branchId);
    if (!conn) return null;
    conn.lastHeartbeat = Date.now();
    return conn.pendingCommands.length > 0 ? conn.pendingCommands.shift()! : null;
  }

  /** Agent sends a command — queues it and waits for widget to execute */
  async sendCommand(branchId: string, command: BridgeCommand): Promise<BridgeResponse> {
    const conn = this.connections.get(branchId);
    if (!conn || Date.now() - conn.lastHeartbeat > CONNECTION_TTL) {
      return { id: command.id, success: false, error: 'no connection', state: emptyState() };
    }

    // Queue the command (FIFO — multiple commands can be queued)
    conn.pendingCommands.push(command);

    // Wait for result
    return new Promise<BridgeResponse>((resolve) => {
      const timer = setTimeout(() => {
        conn.pendingResolvers.delete(command.id);
        // Remove from queue if not yet picked up
        const idx = conn.pendingCommands.findIndex(c => c.id === command.id);
        if (idx !== -1) conn.pendingCommands.splice(idx, 1);
        resolve({
          id: command.id,
          success: false,
          error: 'timeout (widget did not respond within 15s)',
          state: conn.lastState || emptyState(),
        });
      }, COMMAND_TIMEOUT);

      conn.pendingResolvers.set(command.id, { resolve, timer });
    });
  }

  private cleanupConnection(branchId: string): void {
    const conn = this.connections.get(branchId);
    if (!conn) return;

    for (const [, pending] of conn.pendingResolvers) {
      clearTimeout(pending.timer);
      pending.resolve({
        id: '',
        success: false,
        error: 'connection closed',
        state: conn.lastState || emptyState(),
      });
    }
    conn.pendingResolvers.clear();
    this.connections.delete(branchId);
    this.onActivityCallback?.(branchId, 'Bridge 已断开');
  }

  /** Get the last known state for a branch */
  getState(branchId: string): PageState | null {
    const conn = this.connections.get(branchId);
    if (!conn || Date.now() - conn.lastHeartbeat > CONNECTION_TTL) return null;
    return conn.lastState;
  }

  /** Check if a branch has an active bridge connection */
  isConnected(branchId: string): boolean {
    const conn = this.connections.get(branchId);
    return !!conn && Date.now() - conn.lastHeartbeat <= CONNECTION_TTL;
  }

  /** List all active connections */
  getConnections(): Array<{ branchId: string; url: string; connectedAt: string }> {
    const now = Date.now();
    const result: Array<{ branchId: string; url: string; connectedAt: string }> = [];
    for (const [branchId, conn] of this.connections) {
      if (now - conn.lastHeartbeat <= CONNECTION_TTL) {
        result.push({
          branchId,
          url: conn.lastState?.url || '',
          connectedAt: conn.connectedAt,
        });
      }
    }
    return result;
  }

  /** Agent starts a session — Widget will begin polling when it detects this */
  startSession(branchId: string): void {
    this.activeSessions.add(branchId);
  }

  /** Agent ends a session — Widget will stop polling */
  endSession(branchId: string): void {
    this.activeSessions.delete(branchId);
    this.cleanupConnection(branchId);
  }

  /** Widget checks if an Agent has activated a session for this branch */
  isSessionActive(branchId: string): boolean {
    return this.activeSessions.has(branchId);
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
    setTimeout(() => { this.navigateRequests.delete(req.id); }, 60_000);
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
    url: '', title: '', domTree: '',
    viewport: { width: 0, height: 0 },
    scrollPosition: { x: 0, y: 0 },
    consoleErrors: [], networkErrors: [],
    timestamp: 0,
  };
}
