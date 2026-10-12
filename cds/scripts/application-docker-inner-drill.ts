import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
import { runApplicationBootstrap, type ApplicationBootstrapContext } from './application-bootstrap-drill.js';
import { CoreImageCache, CORE_IMAGE_CACHE_IDLE_MS } from '../src/services/core-image-cache.js';
import { createJanitorDockerAdapters } from '../src/services/janitor.js';
import type { IShellExecutor } from '../src/types.js';

// 在外层自有容器里运行；原 index 与 Docker 发布端口在同一个网络空间，保留原分支网络隔离。
const execute = promisify(execFile);
const host = 'unix:///var/run/owned.sock';
const docker = async (args: string[], timeout = 120_000) => (await execute('docker', ['--host', host, ...args],
  { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 120_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) { const value = await read(); if (value !== undefined) return value;
    if (performance.now() >= deadline) throw new Error('完整应用自有Docker检查到期'); await sleep(300); }
}
async function availablePort(): Promise<number> {
  const server = http.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
// Controlled failure boundary: the original CLI sends its real create body to
// this private Unix proxy. After client cancellation the same body is forwarded
// to the real, initially-empty owned daemon. It is an injected delayed request,
// not a claim that the daemon naturally reproduced the delay in this run.
export function numericProbeExitCode(value: unknown): number | null {
  return typeof value === 'string' && /^-?\d{1,10}$/.test(value) && Number.isSafeInteger(Number(value))
    && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : null;
}
// Keep function symbols only: raw goroutine dumps include arguments and host paths.
function daemonStackSummary(text: string, phase: 'creation' | 'removal') {
  const blocks = text.split(/\n\n/), matches: Array<{ state: string; functions: string[] }> = [];
  for (const block of blocks) {
    if (!/^goroutine \d+ \[[^\]]+\]:/m.test(block)) continue;
    const functions = block.split('\n').map(line => line.match(/^((?:[A-Za-z0-9_-]+[./])+[A-Za-z0-9_-]+(?:\.\(\*?[A-Za-z0-9_]+\))?(?:\.[A-Za-z0-9_]+)*)\(/)?.[1])
      .filter((name): name is string => Boolean(name) && /^(?:github\.com\/(?:docker\/docker|moby\/moby)\/|os\.|syscall\.|sync\.|internal\/poll\.)/.test(name!));
    const relevant = phase === 'creation'
      ? /(?:containerCreate|createContainer|CreateRWLayer|createRWLayer|graphdriver\/vfs.*(?:Create|create|Copy|copy))/
      : /(?:cleanupContainer|containerRm|ReleaseLayer|ReleaseRWLayer|RemoveAll|removeAll|graphdriver\/vfs|imageDeleteHelper)/;
    if (!functions.some(name => relevant.test(name))) continue;
    const state = block.match(/^goroutine \d+ \[([^\]]+)\]:/m)?.[1] || 'unknown';
    matches.push({ state: /^(?:IO wait|syscall|runnable|running|chan receive|select|semacquire|sync\.Mutex\.Lock)(?:, \d+ minutes)?$/.test(state) ? state : 'other',
      functions: functions.slice(0, 24) });
    if (matches.length >= 64) break;
  }
  return { matched: matches, truncated: matches.length >= 64, inputBytes: Buffer.byteLength(text) };
}
export function removalStackSummary(text: string) { return daemonStackSummary(text, 'removal'); }
export function creationStackSummary(text: string) { return daemonStackSummary(text, 'creation'); }
type PendingCreateTarget = { containerName: string; operationId: string; instanceId: string; imageReference: string; forwardedAt: string };
export async function createProbeDaemonProxy(socketPath: string, daemonSocketPath = '/var/run/owned.sock',
  cancelBoundary: 'client-disconnect' | 'daemon-created' = 'client-disconnect',
  pendingWait?: (containerId: string, elapsedMs: number) => Promise<void>,
  pendingCreate?: (target: PendingCreateTarget, elapsedMs: number) => Promise<void>) {
  const timeline: any[] = []; const sockets = new Set<net.Socket>(); const requests = new Set<http.ClientRequest>();
  const requestTimeline: any[] = []; let requestSequence = 0, traceEnabled = false, traceOverflow = 0;
  const classify = (url = '', method = '') => {
    const pathname = new URL(url, 'http://owned').pathname;
    const container = pathname.match(/\/containers\/([^/]+)\/(attach|start|wait|json)$/);
    const kind = container ? `container-${container[2] === 'json' ? 'inspect' : container[2]}`
      : /\/containers\/create$/.test(pathname) ? 'container-create'
        : method === 'DELETE' && /\/containers\/[^/]+$/.test(pathname) ? 'container-remove' : undefined;
    const target = container?.[1] || (kind === 'container-remove' ? pathname.split('/').at(-1) : undefined);
    return { kind, containerId: target && /^[a-f0-9]{64}$/.test(target) ? target : null };
  };
  const trace = (request: http.IncomingMessage) => {
    const identity = classify(request.url, request.method), requestId = ++requestSequence;
    const active = traceEnabled && Boolean(identity.kind);
    return (phase: string, fields: Record<string, unknown> = {}) => {
      if (!active) return;
      if (requestTimeline.length >= 1024) { traceOverflow++; return; }
      requestTimeline.push({ requestId, at: new Date().toISOString(), kind: identity.kind,
        method: request.method, containerId: identity.containerId, phase, ...fields });
    };
  };
  const traffic = new Map<string, { kind: string; method: string; requests: number; replies: Record<string, number>; transportErrors: number }>();
  let armed = false; let caughtResolve!: () => void; let settledResolve!: () => void;
  const caught = new Promise<void>(resolve => { caughtResolve = resolve; });
  const settled = new Promise<void>(resolve => { settledResolve = resolve; });
  let captured = false;
  const record = (phase: string, fields: Record<string, unknown> = {}) => { timeline.push({ phase, at: new Date().toISOString(), ...fields }); };
  type StopReplyGate = { containerName: string; claimed: boolean; released: boolean;
    caught: Promise<{ at: string; status: number }>; confirm: (value: { at: string; status: number }) => void;
    release: () => void; expired: boolean; timer?: ReturnType<typeof setTimeout>; send?: () => void };
  let stopGate: StopReplyGate | undefined;
  const holdNextStop = (containerName: string) => {
    assert.match(containerName, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/); assert.equal(stopGate, undefined);
    let confirm!: (value: { at: string; status: number }) => void;
    const caught = new Promise<{ at: string; status: number }>(resolve => { confirm = resolve; });
    const gate: StopReplyGate = { containerName, claimed: false, released: false, caught, confirm,
      expired: false, release: () => {
        if (gate.released) return; gate.released = true; if (gate.timer) clearTimeout(gate.timer);
        record('fixture-stop-reply-released', { containerName, expired: gate.expired });
        gate.send?.(); if (stopGate === gate) stopGate = undefined;
      } };
    stopGate = gate;
    return { caught, release: gate.release, expired: () => gate.expired };
  };
  type AppStartReply = { at: string; status: number; containerId: string; containerName: string; imageReference: string; startReference: string; namedIdentityConfirmed: boolean };
  type AppStartTarget = { projectId: string; branchId: string; profileId: string; imageReference: string };
  type StartReplyGate = { target: AppStartTarget; creationClaimed: boolean; containerId?: string; containerName?: string;
    claimed: boolean; released: boolean; caught: Promise<AppStartReply>; confirm: (reply: AppStartReply) => void;
    expired: boolean; timer?: ReturnType<typeof setTimeout>; identityRequest?: http.ClientRequest; send?: () => void; release: () => void };
  let startGate: StartReplyGate | undefined;
  const holdNextAppStart = (target: AppStartTarget) => {
    for (const value of [target.projectId, target.branchId, target.profileId]) assert.match(value, /^[a-zA-Z0-9_.-]{1,128}$/);
    assert.match(target.imageReference, /^127\.0\.0\.1:\d{1,5}\/owned-(?:api|web)@sha256:[a-f0-9]{64}$/);
    assert.equal(startGate, undefined);
    let confirm!: (reply: AppStartReply) => void;
    const caught = new Promise<AppStartReply>(resolve => { confirm = resolve; });
    const gate: StartReplyGate = { target: { ...target }, creationClaimed: false, claimed: false, released: false, caught, confirm,
      expired: false, release: () => {
        if (gate.released) return; gate.released = true; if (gate.timer) clearTimeout(gate.timer);
        gate.identityRequest?.destroy(); gate.identityRequest = undefined;
        record('fixture-app-start-reply-released', { containerId: gate.containerId, expired: gate.expired });
        gate.send?.(); if (startGate === gate) startGate = undefined;
      } };
    startGate = gate;
    return { caught, release: gate.release, expired: () => gate.expired };
  };
  type InfraInspectGate = { containerName: string; count: 1 | 2; mode: 'hold' | 'disconnect' | 'unavailable';
    replies: Array<{ at: string; status: number; ordinal: number }>; sends: Array<() => void>; released: boolean; expired: boolean;
    confirm: (values: Array<{ at: string; status: number; ordinal: number }>) => void;
    timer?: ReturnType<typeof setTimeout>; release: () => void };
  let infraGate: InfraInspectGate | undefined;
  const holdInfraInspects = (containerName: string, count: 1 | 2 = 2, mode: 'hold' | 'disconnect' | 'unavailable' = 'hold') => {
    assert.match(containerName, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/); assert.ok(count === 1 || count === 2); assert.equal(infraGate, undefined);
    assert.ok(mode === 'hold' || mode === 'disconnect' || mode === 'unavailable');
    let confirm!: InfraInspectGate['confirm'];
    const caught = new Promise<InfraInspectGate['replies']>(resolve => { confirm = resolve; });
    const gate: InfraInspectGate = { containerName, count, mode, replies: [], sends: [], released: false, expired: false, confirm,
      release: () => {
        if (gate.released) return; gate.released = true; if (gate.timer) clearTimeout(gate.timer);
        record('fixture-infra-inspect-released', { containerName, mode, replies: gate.replies.length, expired: gate.expired });
        for (const send of gate.sends) send(); if (infraGate === gate) infraGate = undefined;
      } };
    infraGate = gate;
    return { caught, release: gate.release, expired: () => gate.expired };
  };
  const server = http.createServer((request, response) => {
    const observe = trace(request); observe('received');
    const kind = /\/images\/create(?:\?|$)/.test(request.url || '') ? 'image-pull'
      : /\/images\/.+\/json(?:\?|$)/.test(request.url || '') ? 'image-inspect'
        : /\/containers\/create(?:\?|$)/.test(request.url || '') ? 'container-create'
          : /\/(?:version|info|_ping)(?:\?|$)/.test(request.url || '') ? 'daemon-read' : 'other';
    const key = `${request.method}:${kind}`;
    const row = traffic.get(key) || { kind, method: request.method || '', requests: 0, replies: {}, transportErrors: 0 };
    row.requests++; traffic.set(key, row);
    const forward = (body?: Buffer, delayed = false, appCreation?: StartReplyGate) => {
      observe('forwarded', { delayed });
      const upstream = http.request({ socketPath: daemonSocketPath, path: request.url, method: request.method,
        headers: request.headers, timeout: 30_000 }, backend => {
        observe('response-headers', { status: backend.statusCode });
        backend.once('end', () => observe('response-ended'));
        if (classify(request.url, request.method).kind === 'container-wait') {
          let bytes = 0; const chunks: Buffer[] = []; const timers: ReturnType<typeof setTimeout>[] = [];
          backend.on('data', chunk => { bytes += chunk.length; if (bytes <= 4096) chunks.push(chunk); });
          backend.once('end', () => {
            let exitCode: number | null = null, errorPresent = false;
            try { const result = bytes <= 4096 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
              exitCode = numericProbeExitCode(String(result?.StatusCode ?? '')); errorPresent = Boolean(result?.Error); } catch { /* Numeric evidence remains unknown. */ }
            observe('wait-terminal', { exitCode, errorPresent, boundedBody: bytes <= 4096 });
          });
          const id = classify(request.url, request.method).containerId;
          if (pendingWait && id && traceEnabled) for (const elapsedMs of [3000, 10_000]) timers.push(setTimeout(() => {
            if (!backend.destroyed && !backend.complete) void pendingWait(id, elapsedMs).catch(() => observe('wait-diagnostic-failed'));
          }, elapsedMs));
          const clear = () => { for (const timer of timers) clearTimeout(timer); };
          backend.once('end', clear); backend.once('close', clear); response.once('close', clear);
        }
        const status = String(backend.statusCode || 0); row.replies[status] = (row.replies[status] || 0) + 1;
        if (!delayed) {
          if (appCreation && backend.statusCode === 201) {
            let bytes = 0; const chunks: Buffer[] = [];
            backend.on('data', chunk => { bytes += chunk.length; if (bytes <= 4096) chunks.push(chunk); });
            backend.once('end', () => {
              try {
                const parsed = bytes <= 4096 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
                if (typeof parsed?.Id === 'string' && /^[a-f0-9]{64}$/.test(parsed.Id)) {
                  appCreation.containerId = parsed.Id;
                  record('original-app-create-replied', { status: 201, containerId: parsed.Id,
                    containerName: appCreation.containerName, ...appCreation.target });
                } else record('original-app-create-id-unconfirmed');
              } catch { record('original-app-create-id-unconfirmed'); }
            });
          }
          const send = () => {
            if (response.destroyed) { backend.destroy(); return; }
            response.writeHead(backend.statusCode || 502, backend.headers);
            // Docker wait acknowledges headers before start; buffering them until
            // the exit body arrives deadlocks the CLI before ContainerStart.
            response.flushHeaders(); backend.pipe(response); backend.resume();
          };
          const inspectTarget = new URL(request.url || '/', 'http://owned').pathname.match(/\/containers\/([^/]+)\/json$/)?.[1];
          const observation = infraGate;
          if (request.method === 'GET' && backend.statusCode === 200 && observation && !observation.released
            && observation.replies.length < observation.count && decodeURIComponent(inspectTarget || '') === observation.containerName) {
            backend.pause();
            observation.sends.push(observation.mode === 'disconnect' ? () => { backend.destroy(); response.destroy(); }
              : observation.mode === 'unavailable' ? () => {
                // Explicit private proxy fault, never reported as a real daemon 503.
                backend.destroy(); if (response.destroyed) return;
                record('fixture-infra-inspect-unavailable', { containerName: observation.containerName, originalStatus: 200, injectedStatus: 503, origin: 'private-proxy' });
                response.writeHead(503, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ message: 'controlled-private-observation-unavailable' }));
              } : send);
            const reply = { at: new Date().toISOString(), status: 200, ordinal: observation.replies.length + 1 };
            observation.replies.push(reply); record('original-infra-inspect-reply-held', { containerName: observation.containerName, mode: observation.mode, ...reply });
            if (!observation.timer) observation.timer = setTimeout(() => { observation.expired = true; observation.release(); }, 2500);
            response.once('close', observation.release);
            if (observation.replies.length === observation.count) observation.confirm([...observation.replies]);
            return;
          }
          const startPath = new URL(request.url || '/', 'http://owned').pathname;
          const startReference = decodeURIComponent(startPath.match(/\/containers\/([^/]+)\/start$/)?.[1] || '');
          const appGate = startGate;
          if (request.method === 'POST' && backend.statusCode === 204 && appGate && !appGate.released && !appGate.claimed
            && appGate.containerId && (startReference === appGate.containerId || startReference === appGate.containerName)) {
            appGate.claimed = true; appGate.send = send; backend.pause();
            const reply = { at: new Date().toISOString(), status: 204, containerId: appGate.containerId,
              containerName: appGate.containerName!, imageReference: appGate.target.imageReference, startReference,
              namedIdentityConfirmed: false };
            // Identity discovery consumes the same original five-second reply
            // budget. A name alone cannot establish ownership of the new CID.
            appGate.timer = setTimeout(() => { appGate.expired = true; appGate.release(); }, 5000);
            response.once('close', appGate.release);
            const confirm = () => {
              if (appGate.released) return;
              record('original-app-start-reply-held', reply); appGate.confirm(reply);
            };
            if (startReference === appGate.containerId) { confirm(); return; }
            const unknown = (reason: string) => {
              if (appGate.released) return;
              record('original-app-named-start-identity-unconfirmed', { containerId: appGate.containerId, reason }); appGate.release();
            };
            const identity = http.request({ socketPath: daemonSocketPath, method: 'GET',
              path: startPath.replace(/\/start$/, '/json'), timeout: 5000 }, inspected => {
              let bytes = 0; const chunks: Buffer[] = [];
              inspected.on('data', chunk => { bytes += chunk.length;
                if (bytes > 256 * 1024) { unknown('oversize'); identity.destroy(); } else chunks.push(chunk); });
              inspected.once('error', () => unknown('transport'));
              inspected.once('end', () => {
                if (appGate.released) return;
                try {
                  const view = inspected.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
                  const expected = { 'cds.managed': 'true', 'cds.type': 'app', 'cds.project.id': appGate.target.projectId,
                    'cds.branch.id': appGate.target.branchId, 'cds.profile.id': appGate.target.profileId };
                  if (view?.Id !== appGate.containerId || view?.Name !== `/${appGate.containerName}`
                    || view?.Config?.Image !== appGate.target.imageReference || view?.State?.Running !== true
                    || !Object.entries(expected).every(([key, value]) => view?.Config?.Labels?.[key] === value)) {
                    unknown('identity-or-status'); return;
                  }
                  appGate.identityRequest = undefined; reply.namedIdentityConfirmed = true;
                  record('original-app-named-start-identity-confirmed', { containerId: view.Id,
                    containerName: appGate.containerName, startReference, status: inspected.statusCode }); confirm();
                } catch { unknown('invalid-body'); }
              });
            });
            appGate.identityRequest = identity; requests.add(identity);
            identity.once('close', () => requests.delete(identity));
            identity.once('timeout', () => { unknown('timeout'); identity.destroy(); });
            identity.once('error', () => unknown('transport')); identity.end(); return;
          }
          const stopTarget = new URL(request.url || '/', 'http://owned').pathname.match(/\/containers\/([^/]+)\/stop$/)?.[1];
          const gate = stopGate;
          if (request.method === 'POST' && backend.statusCode === 204 && gate && !gate.claimed
            && decodeURIComponent(stopTarget || '') === gate.containerName) {
            // The real daemon already stopped this exact private fixture. Hold
            // only its real reply, without rewriting or reissuing the request.
            gate.claimed = true; gate.send = send; backend.pause();
            const at = new Date().toISOString(); record('original-stop-reply-held', { containerName: gate.containerName, status: 204 });
            gate.timer = setTimeout(() => { gate.expired = true; gate.release(); }, 5000);
            response.once('close', gate.release); gate.confirm({ at, status: 204 });
          } else send();
        }
        else {
          let text = ''; backend.on('data', chunk => { text += chunk; });
          backend.on('end', () => {
            try { const view = JSON.parse(text); record('backend-create-replied', { status: backend.statusCode, containerId: view.Id ?? null });
              if (cancelBoundary === 'daemon-created' && backend.statusCode === 201 && typeof view.Id === 'string' && /^[a-f0-9]{64}$/.test(view.Id)) caughtResolve(); }
            catch { record('backend-create-invalid-reply', { status: backend.statusCode }); }
            settledResolve();
          });
        }
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      if (!delayed) { response.once('close', () => upstream.destroy()); response.once('error', () => upstream.destroy()); }
      upstream.once('timeout', () => { observe('transport-timeout'); upstream.destroy(new Error('owned proxy timeout')); });
      upstream.once('error', () => { observe('transport-error'); row.transportErrors++; if (delayed) { record('backend-create-transport-error'); settledResolve(); }
        else if (!response.destroyed) { if (!response.headersSent) response.statusCode = 502; response.end(); } });
      if (body) upstream.end(body); else request.pipe(upstream);
      // Observe the one injected original create before the daemon replies.
      // Never await observers or change forwarding, cancellation or deadlines.
      if (delayed && body && pendingCreate) {
        const config = JSON.parse(body.toString('utf8'));
        const containerName = new URL(request.url!, 'http://owned').searchParams.get('name');
        const operationId = config.Labels?.['cds.agent.probe.operation'], instanceId = config.Labels?.['cds.instance'];
        if (containerName && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName)
          && typeof config.Image === 'string' && /^[a-f0-9]{32}$/.test(operationId || '') && /^[a-f0-9]{12}$/.test(instanceId || '')) {
          const target: PendingCreateTarget = { containerName, operationId, instanceId, imageReference: config.Image, forwardedAt: new Date().toISOString() };
          let replied = false;
          const timers = [0, 3000].map(elapsedMs => setTimeout(() => {
            if (!upstream.destroyed && !replied) void Promise.resolve().then(() => pendingCreate(target, elapsedMs))
              .catch(() => record('create-diagnostic-failed', { elapsedMs }));
          }, elapsedMs));
          const clear = () => { for (const timer of timers) clearTimeout(timer); };
          upstream.once('response', () => { replied = true; clear(); }); upstream.once('close', clear); upstream.once('error', clear);
        }
      }
    };
    if ((!armed && !startGate) || !/\/containers\/create(?:\?|$)/.test(request.url || '')) { forward(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      const body = Buffer.concat(chunks); let config: any;
      try { config = JSON.parse(body.toString('utf8')); } catch { response.statusCode = 400; response.end(); return; }
      const appGate = startGate;
      if (appGate && !appGate.released && !appGate.creationClaimed && config.Labels?.['cds.managed'] === 'true'
        && config.Labels?.['cds.type'] === 'app' && config.Labels?.['cds.project.id'] === appGate.target.projectId
        && config.Labels?.['cds.branch.id'] === appGate.target.branchId && config.Labels?.['cds.profile.id'] === appGate.target.profileId
        && config.Image === appGate.target.imageReference) {
        const name = new URL(request.url!, 'http://owned').searchParams.get('name');
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) { record('original-app-create-name-unconfirmed'); forward(body); return; }
        appGate.creationClaimed = true; appGate.containerName = name;
        record('original-app-create-matched', { containerName: appGate.containerName, ...appGate.target });
        forward(body, false, appGate); return;
      }
      if (!armed || config.Labels?.['cds.agent.probe'] !== 'runtime-validation') { forward(body); return; }
      armed = false; captured = true;
      record('original-create-received', { name: new URL(request.url!, 'http://owned').searchParams.get('name'),
        operationId: config.Labels['cds.agent.probe.operation'], instanceId: config.Labels['cds.instance'], image: config.Image,
        cmdHash: createHash('sha256').update(JSON.stringify(config.Cmd)).digest('hex'),
        entrypointHash: createHash('sha256').update(JSON.stringify(config.Entrypoint)).digest('hex'),
        memoryBytes: config.HostConfig.Memory, nanoCpus: config.HostConfig.NanoCpus, pidsLimit: config.HostConfig.PidsLimit,
        readonlyRootfs: config.HostConfig.ReadonlyRootfs, autoRemove: config.HostConfig.AutoRemove, networkMode: config.HostConfig.NetworkMode });
      response.once('close', () => { record('original-client-disconnected');
        if (cancelBoundary === 'client-disconnect') setTimeout(() => {
          record('forward-after-client-disconnect'); forward(body, true);
        }, 250); });
      if (cancelBoundary === 'daemon-created') { record('forward-before-client-disconnect'); forward(body, true); }
      else caughtResolve();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, client, head) => {
    const observe = trace(request); observe('received-upgrade');
    const backend = net.connect(daemonSocketPath); sockets.add(backend); backend.once('close', () => sockets.delete(backend));
    let handshake = Buffer.alloc(0), statusRecorded = false, upstreamBytes = 0, downstreamBytes = head.length;
    backend.on('data', chunk => {
      upstreamBytes += chunk.length;
      if (!statusRecorded) {
        if (handshake.length + chunk.length > 4096) { statusRecorded = true; observe('upgrade-header-limit'); }
        else { handshake = Buffer.concat([handshake, chunk]); if (handshake.includes('\r\n\r\n')) {
          statusRecorded = true; const status = handshake.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
          observe('upgrade-response', { status: status ? Number(status[1]) : null }); handshake = Buffer.alloc(0);
        } }
      }
    });
    client.on('data', chunk => { downstreamBytes += chunk.length; });
    backend.once('end', () => observe('backend-ended', { upstreamBytes, downstreamBytes }));
    client.once('end', () => observe('client-input-ended', { upstreamBytes, downstreamBytes }));
    backend.once('close', () => observe('backend-closed', { upstreamBytes, downstreamBytes }));
    client.once('close', () => observe('client-closed', { upstreamBytes, downstreamBytes }));
    backend.once('connect', () => { observe('connected-upgrade'); backend.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`
      + request.rawHeaders.reduce((text, value, index, list) => index % 2 ? text : text + `${value}: ${list[index + 1]}\r\n`, '') + '\r\n');
      if (head.length) backend.write(head); client.pipe(backend).pipe(client); });
    backend.on('error', () => { observe('backend-error'); client.destroy(); });
    client.on('error', () => { observe('client-error'); backend.destroy(); }); client.on('close', () => backend.destroy());
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  return { timeline, requestTimeline, traceOverflow: () => traceOverflow, enableTrace: () => { traceEnabled = true; },
    holdNextStop, holdNextAppStart, holdInfraInspects,
    traffic: () => [...traffic.values()], arm: () => { armed = true; traceEnabled = true; }, caught,
    settle: () => captured ? Promise.race([settled, sleep(35_000).then(() => { throw new Error('注入的创建请求未获得终态'); })]) : Promise.resolve(),
    close: async () => { infraGate?.release(); stopGate?.release(); startGate?.release(); for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.equal(path.resolve('.'), '/owned/source');
  const cancelBoundary = process.argv.includes('--cancel-after-daemon-create') ? 'daemon-created' : 'client-disconnect';
  const source = JSON.parse(await fs.readFile('owned-source.json', 'utf8')); assert.match(source.sourceHead, /^[a-f0-9]{40}$/); assert.match(source.owner, /^cds_app_[a-f0-9]{16}$/);
  for (const [name, hash] of Object.entries(source.hashes)) {
    assert.ok(!path.isAbsolute(name) && !name.split(path.sep).includes('..'));
    assert.equal(createHash('sha256').update(await fs.readFile(name)).digest('hex'), hash);
  }
  // 只读固定源码中两项常量；为真实inspect建立精确命令摘要，不记录任何容器env或任意argv。
  const capabilitySource = await fs.readFile('src/services/agent-workspace-session-runtime.ts', 'utf8');
  const codeVersion = capabilitySource.match(/export const OPEN_DESIGN_CODEX_VERSION = '([^']+)';/)?.[1];
  const prototypeSource = capabilitySource.match(/const OPEN_DESIGN_WEB_PROTOTYPE_SOURCE = '([^']+)';/)?.[1];
  const capabilityImage = capabilitySource.match(/export const OPEN_DESIGN_IMAGE = '([^']+)';/)?.[1];
  assert.ok(codeVersion && prototypeSource && capabilityImage);
  const validationScript = [
    `test "$(codex --version)" = "codex-cli ${codeVersion}"`,
    ...['SKILL.md', 'assets/template.html', 'references/layouts.md', 'references/checklist.md']
      .map(name => `test -f ${prototypeSource}/${name}`),
  ].join(' && ');
  const jsonHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const expectedCapabilityProbe = { sourceHash: createHash('sha256').update(capabilitySource).digest('hex'),
    imageReference: capabilityImage, entrypointHash: jsonHash(['/bin/sh']), cmdHash: jsonHash(['-lc', validationScript]),
    autoRemove: true, readonlyRootfs: true, networkMode: 'none', memoryBytes: 128 * 1024 * 1024,
    nanoCpus: 250_000_000, pidsLimit: 64 };
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])); assert.ok(info.ID);
  assert.equal(await docker(['ps', '-aq']), ''); // 外层刚建的空守护进程，不接共享 socket。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-app-fixtures-')); await fs.chmod(root, 0o700);
  const report: any = { schema: 1, sourceHead: source.sourceHead, owner: source.owner, daemonId: info.ID, checks: [],
    expectedCapabilityProbe, startedAt: new Date().toISOString(), verdict: 'failed', genericFixtureOnly: true, representativeBusinessCiVerified: false,
    firstStageVerified: false, performanceVerified: false, abnormalRestartVerified: false, infrastructureRecoveryVerified: false,
    branchNetworkIsolationDisabled: false, noPrimaryDockerSocket: true, ownedContainersRemoved: false };
  // A completed application phase must survive an unrelated later failure.
  // This atomic partial report never replaces the final report or its verdict.
  const checkpoint = async (stage: string) => {
    report.evidenceCheckpoints ||= [];
    assert.ok(report.evidenceCheckpoints.length < 12);
    report.evidenceCheckpoints.push({ stage, at: new Date().toISOString() });
    const filename = '/owned/output/docker-report.checkpoint.json';
    await fs.writeFile(`${filename}.tmp`, JSON.stringify({ ...report,
      partialCheckpointOnly: true, finalReportPresent: false,
      wholeCaseVerified: false, formalAcceptancePassed: false }, null, 2) + '\n');
    await fs.rename(`${filename}.tmp`, filename);
  };
  const containers = new Set<string>(); const images = new Set<string>();
  let probeProxy: Awaited<ReturnType<typeof createProbeDaemonProxy>> | undefined;
  const ownedView = async (id: string) => {
    const view = JSON.parse(await docker(['inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner); return view;
  };
  const auditNamespace = async (stage: string) => {
    assert.equal(JSON.parse(await docker(['info', '--format', '{{json .}}'])).ID, info.ID);
    const rows: any[] = [];
    for (const id of (await docker(['ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean)) {
      const view = JSON.parse(await docker(['inspect', id]))[0]; assert.equal(view.Id, id);
      const owner = view.Config.Labels?.['cds.acceptance.owner'] || null;
      assert.ok(!owner || owner === source.owner, '独占空间发现其他归属，不猜测删除');
      const capabilityProbeIdentity = { imageReference: view.Config.Image,
        entrypointHash: jsonHash(view.Config.Entrypoint), cmdHash: jsonHash(view.Config.Cmd),
        autoRemove: view.HostConfig.AutoRemove, readonlyRootfs: view.HostConfig.ReadonlyRootfs,
        networkMode: view.HostConfig.NetworkMode, memoryBytes: view.HostConfig.Memory,
        nanoCpus: view.HostConfig.NanoCpus, pidsLimit: view.HostConfig.PidsLimit };
      const matchesDefaultRuntimeValidation = Object.entries(expectedCapabilityProbe)
        .filter(([key]) => key !== 'sourceHash')
        .every(([key, value]) => (capabilityProbeIdentity as Record<string, unknown>)[key] === value);
      rows.push({ id, name: view.Name, image: view.Image, created: view.Created, status: view.State.Status,
        running: view.State.Running, pid: view.State.Pid, owner, capabilityProbeIdentity, matchesDefaultRuntimeValidation, networkMode: view.HostConfig.NetworkMode,
        networks: Object.keys(view.NetworkSettings.Networks || {}),
        namespaceOwnership: 'initial-empty-private-daemon-and-volume; unchanged-daemon-id; no-primary-socket' });
    }
    report.namespaceInventories ||= []; report.namespaceInventories.push({ stage, at: new Date().toISOString(), daemonId: info.ID, rows }); return rows;
  };
  const processSnapshot = async (stage: string) => {
    const text = (await execute('ps', ['-eo', 'pid,ppid,pgid,stat,rss,comm'], { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 })).stdout;
    report.processSnapshots ||= []; report.processSnapshots.push({ stage, at: new Date().toISOString(), text });
  };
  const eventSnapshot = async (stage: string) => {
    // 所有事件均来自独占daemon；只保存身份/行为，舍弃任意标签与环境内容。
    const from = String(Math.floor(new Date(report.startedAt).getTime() / 1000));
    const to = String(Math.floor(Date.now() / 1000) + 1);
    const text = await docker(['events', '--since', from, '--until', to, '--format', '{{json .}}'], 10_000);
    const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(events.length <= 4096, '独占事件证据超过上限，不静默截断');
    report.namespaceEventSnapshots ||= []; report.namespaceEventSnapshots.push({ stage, at: new Date().toISOString(), events: events.map(event => ({
      time: event.time, timeNano: event.timeNano, type: event.Type, action: event.Action, id: event.Actor?.ID,
      name: event.Actor?.Attributes?.name || null, image: event.Actor?.Attributes?.image || null,
      owner: event.Actor?.Attributes?.['cds.acceptance.owner'] || null,
      probeOperationId: event.Actor?.Attributes?.['cds.agent.probe.operation'] || null,
      probeKind: event.Actor?.Attributes?.['cds.agent.probe'] || null,
      exitCode: numericProbeExitCode(event.Actor?.Attributes?.exitCode),
      instanceId: event.Actor?.Attributes?.['cds.instance'] || null })) });
    return report.namespaceEventSnapshots.at(-1).events as any[];
  };
  const run = async (name: string, args: string[]) => {
    const id = await docker(['run', '-d', '--label', `cds.acceptance.owner=${source.owner}`, '--name', `${source.owner}-${name}`, ...args]);
    assert.match(id, /^[a-f0-9]{64}$/); containers.add(id); await ownedView(id); return id;
  };
  const comparePinnedProbe = async (route: 'direct' | 'proxy', proxyHost: string) => {
    const name = `${source.owner}-protocol-${route}`, instanceId = `${source.owner}-protocol`;
    const operationId = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const cidFile = path.join(root, `${route}.cid`), started = performance.now();
    const result: any = { route, name, instanceId, operationId, startedAt: new Date().toISOString(),
      originalProbeSpec: expectedCapabilityProbe, timeoutMs: 30_000, driverOwnedComparison: true,
      originalApplicationCapabilityVerified: false };
    (report.probeProtocolComparisons ??= []).push(result);
    try { result.imageIdBefore = await docker(['image', 'inspect', capabilityImage, '--format', '{{.Id}}'], 5000); }
    catch { result.imageIdBefore = null; }
    try {
      await execute('docker', ['--host', route === 'direct' ? host : proxyHost, 'run', '--rm', '--name', name, '--cidfile', cidFile,
        '--label', `cds.acceptance.owner=${source.owner}`, '--label', 'cds.managed=true', '--label', 'cds.type=agent-session',
        '--label', `cds.instance=${instanceId}`, '--label', 'cds.agent.probe=runtime-validation', '--label', `cds.agent.probe.operation=${operationId}`,
        '--pull', 'never', '--read-only', '--network', 'none', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
        '--pids-limit', '64', '--memory', '128m', '--cpus', '0.25', '--entrypoint', '/bin/sh', capabilityImage, '-lc', validationScript],
      { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
      result.exitCode = 0; result.originalRuntimeVersionAndSkillProbePassed = true;
    } catch (error) {
      result.exitCode = typeof (error as any).code === 'number' ? (error as any).code : null;
      result.interrupted = Boolean((error as any).killed); result.originalRuntimeVersionAndSkillProbePassed = false;
    }
    result.endedAt = new Date().toISOString(); result.elapsedMs = performance.now() - started;
    try {
      const descriptor = await fs.open(cidFile, 'r');
      try { const data = Buffer.alloc(129), read = await descriptor.read(data, 0, data.length, 0);
        const id = data.subarray(0, read.bytesRead).toString('utf8').trim();
        if (/^[a-f0-9]{64}$/.test(id)) result.containerId = id;
      } finally { await descriptor.close(); }
    } catch { /* No CID is unknown, not proof that a timed-out create was revoked. */ }
    try {
      const view = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name], 5000));
      assert.match(view.Id, /^[a-f0-9]{64}$/); assert.equal(view.Name, '/' + name);
      assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner);
      assert.equal(view.Config.Labels['cds.instance'], instanceId); assert.equal(view.Config.Labels['cds.agent.probe.operation'], operationId);
      result.containerId = view.Id; result.stateBeforeDriverCleanup = view.State.Status;
      await docker(['rm', '-f', view.Id], 30_000); result.driverCleanupConfirmed = true;
    } catch { result.driverCleanupConfirmed = false; }
    await eventSnapshot(`protocol-comparison-${route}-after-original-recovery-failure`);
  };
  const build = async (role: string, sha: string, registry: string) => {
    const context = path.join(root, `${role}-${sha}`); await fs.mkdir(context);
    await fs.writeFile(path.join(context, 'server.cjs'), `require('node:http').createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({service:process.env.SERVICE_NAME,source:'${sha}',runtime:process.env.CDS_COMMIT_SHA}));}).listen(8080,'0.0.0.0');`);
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM node:22-alpine\nLABEL cds.acceptance.owner="${source.owner}" org.opencontainers.image.revision="${sha}" cds.acceptance.role="${role}"\nCOPY server.cjs /app/server.cjs\nEXPOSE 8080\nCMD ["node","/app/server.cjs"]\n`);
    const reference = `${registry}/owned-${role}:sha-${sha}`; await docker(['build', '--network', 'none', '--quiet', '-t', reference, context]);
    const view = JSON.parse(await docker(['image', 'inspect', reference]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner);
    assert.equal(view.Config.Labels['org.opencontainers.image.revision'], sha); images.add(view.Id); await docker(['push', reference]);
    report.publishedImages ||= []; report.publishedImages.push({ role, sha, reference, id: view.Id, repoDigests: JSON.parse(await docker(['image', 'inspect', reference]))[0].RepoDigests,
      os: view.Os, architecture: view.Architecture });
  };
  let finiteCache: { finish: () => Promise<void>; stop: () => void } | undefined;
  const prepareFiniteCoreCache = async (applicationCoreImageId: string) => {
    // Only this independent fixture's single lease overlaps application stop.
    // Prune/release assertions still follow the original application assertions.
    const evidence: any = { startedAt: new Date().toISOString(), verdict: 'failed',
      genericFixtureOnly: true, originalApplicationCapabilityVerified: false,
      originalPruneEnabled: true, originalIdleMs: CORE_IMAGE_CACHE_IDLE_MS, events: [] };
    report.coreImageCacheRepresentative = evidence;
    const shell: IShellExecutor = { exec: async (command, options) => {
      options?.beforeStart?.();
      try { const output = await execute('/bin/sh', ['-c', command], { encoding: 'utf8',
        timeout: options?.timeout, signal: options?.signal, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, DOCKER_HOST: host } });
        return { stdout: output.stdout, stderr: output.stderr, exitCode: 0 }; }
      catch (error) { return { stdout: String((error as any).stdout || ''), stderr: String((error as any).stderr || (error as Error).message),
        exitCode: typeof (error as any).code === 'number' ? (error as any).code : 1 }; }
    } };
    const cacheRoot = path.join(root, 'finite-core-cache');
    const cache = new CoreImageCache(shell, cacheRoot, `${source.owner}-finite-cache`, () => true,
      { record: (event: any) => { evidence.events.push(event); } });
    try {
      await cache.resume(); assert.equal(evidence.events.length, 0);
      evidence.foreignReferencesBefore = {};
      for (const reference of ['mongo:7.0', 'registry:2', 'node:22-alpine'])
        evidence.foreignReferencesBefore[reference] = await docker(['image', 'inspect', reference, '--format', '{{.Id}}']);
      const makeFixture = async (role: string) => {
        const context = path.join(root, `finite-cache-${role}`); await fs.mkdir(context);
        await fs.writeFile(path.join(context, 'marker'), `${source.owner}:${role}`);
        await fs.writeFile(path.join(context, 'Dockerfile'), `FROM scratch\nLABEL cds.acceptance.owner="${source.owner}"\nCOPY marker /marker\n`);
        const reference = `${source.owner}-finite-cache:${role}`;
        await docker(['build', '--network', 'none', '--quiet', '-t', reference, context]);
        const view = JSON.parse(await docker(['image', 'inspect', reference]))[0];
        assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner);
        return { reference, id: view.Id, size: view.Size };
      };
      const active = await makeFixture('active');
      assert.notEqual(active.id, applicationCoreImageId);
      evidence.fixtureImages = { active };
      evidence.originalApplicationCoreImageId = applicationCoreImageId;
      evidence.fixtureDoesNotProtectApplicationCoreImage = true;
      const release = await cache.acquire(active.id, new AbortController().signal);
      const receipt = JSON.parse(await fs.readFile(path.join(cacheRoot, 'cache.json'), 'utf8'));
      assert.equal(receipt.daemonId, info.ID); assert.equal(receipt.entries.length, 1);
      assert.equal(receipt.entries[0].imageId, active.id); assert.equal(receipt.entries[0].size, active.size);
      assert.ok((await fs.stat(path.join(cacheRoot, 'cache.json'))).size <= 8192);
      evidence.receiptAtAcquisition = receipt;
      evidence.originalExpiresAt = receipt.entries[0].expiresAt;
      evidence.singleLeasePreparedBeforeApplicationShutdown = true;
      await checkpoint('finite-core-cache-acquired');
      const acquired = evidence.events.find((event: any) => event.action === 'agent.core-image-cache.acquired');
      assert.ok(acquired); evidence.ownedReference = acquired.details.cacheReference;
      return { stop: () => cache.stop(), finish: async () => {
        try {
          evidence.finalAssertionsStartedAt = new Date().toISOString();
          assert.equal(evidence.events.filter((event: any) => event.action === 'agent.core-image-cache.acquired').length, 1);
          assert.equal(evidence.events.some((event: any) => event.action === 'agent.core-image-cache.released'), false);
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(cacheRoot, 'cache.json'), 'utf8')), receipt);
          // Create the unused fixture here so original application janitor work
          // cannot reclaim it before the original explicit prune assertion.
          const unused = await makeFixture('unused');
          assert.notEqual(active.id, unused.id); evidence.fixtureImages.unused = unused;
          await docker(['image', 'rm', '--no-prune', active.reference]);
          // Replacing a build tag leaves the old image genuinely dangling. Removing
          // its sole tag with image rm would already delete it before prune.
          const unusedContext = path.join(root, 'finite-cache-unused');
          await fs.writeFile(path.join(unusedContext, 'marker'), `${source.owner}:unused:replacement`);
          await docker(['build', '--network', 'none', '--quiet', '-t', unused.reference, unusedContext]);
          const replacement = JSON.parse(await docker(['image', 'inspect', unused.reference]))[0];
          assert.equal(replacement.Config.Labels['cds.acceptance.owner'], source.owner);
          assert.notEqual(replacement.Id, unused.id);
          evidence.unusedReplacement = { reference: unused.reference, id: replacement.Id, size: replacement.Size };
          const dangling = JSON.parse(await docker(['image', 'inspect', unused.id]))[0];
          assert.equal(dangling.Id, unused.id); assert.deepEqual(dangling.RepoTags || [], []);
          assert.deepEqual(dangling.RepoDigests || [], []);
          assert.equal(await docker(['ps', '-aq', '--filter', `ancestor=${unused.id}`]), '');
          evidence.unusedBeforePrune = { at: new Date().toISOString(), imageId: dangling.Id,
            repoTags: dangling.RepoTags || [], repoDigests: dangling.RepoDigests || [], referencedContainers: 0 };
          const prune = createJanitorDockerAdapters(shell).dockerPrune;
          const absentImage = async (reference: string) => {
            try { await docker(['image', 'inspect', reference, '--format', '{{.Id}}']); return false; }
            catch (error) { assert.match(String((error as any).stderr || ''), /No such (?:image|object)/i); return true; }
          };
          evidence.activePrune = await prune(); assert.deepEqual(evidence.activePrune.errors, []);
          evidence.pruneFinishedAt = new Date().toISOString();
          assert.equal(await docker(['image', 'inspect', active.id, '--format', '{{.Id}}']), active.id);
          assert.equal(await absentImage(unused.id), true); evidence.unusedReclaimedWhileActiveProtected = true;
          await checkpoint('finite-core-cache-original-active-prune-complete');
          const waitStarted = performance.now();
          await sleep(Math.max(0, receipt.entries[0].expiresAt - Date.now()) + 25);
          evidence.expiryWaitMs = performance.now() - waitStarted; evidence.expiredAt = new Date().toISOString();
          assert.ok(Date.now() >= receipt.entries[0].expiresAt);
          assert.equal(receipt.entries[0].expiresAt, evidence.originalExpiresAt);
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(cacheRoot, 'cache.json'), 'utf8')), receipt);
          await cache.reclaimExpired();
          assert.equal(await docker(['image', 'inspect', evidence.ownedReference, '--format', '{{.Id}}']), active.id);
          evidence.activeUserProtectedPastExpiry = true;
          await checkpoint('finite-core-cache-original-idle-expiry-reached');
          release(); await cache.reclaimExpired();
          assert.equal(await absentImage(evidence.ownedReference), true);
          await assert.rejects(fs.stat(cacheRoot), (error: any) => error.code === 'ENOENT');
          evidence.afterReleasePrune = await prune(); assert.deepEqual(evidence.afterReleasePrune.errors, []);
          assert.equal(await absentImage(active.id), true);
          evidence.foreignReferencesAfter = {};
          for (const reference of Object.keys(evidence.foreignReferencesBefore))
            evidence.foreignReferencesAfter[reference] = await docker(['image', 'inspect', reference, '--format', '{{.Id}}']);
          assert.deepEqual(evidence.foreignReferencesAfter, evidence.foreignReferencesBefore);
          evidence.ownedReferenceAndReceiptRemoved = true; evidence.verdict = 'passed';
          await checkpoint('finite-core-cache-release-and-foreign-reference-checks-complete');
        } finally { cache.stop(); evidence.finishedAt = new Date().toISOString(); }
      } };
    } catch (error) { cache.stop(); evidence.preparationFailedAt = new Date().toISOString(); throw error; }
  };
  try {
    report.stage = 'owned-fixtures-ready';
    for (const image of ['mongo:7.0', 'registry:2', 'node:22-alpine']) await docker(['pull', image]);
    const mongoPort = await availablePort(), registryPort = await availablePort(); assert.notEqual(mongoPort, registryPort);
    await run('mongo', ['--network', 'host', '--cpus', '0.5', '--memory', '768m', 'mongo:7.0', 'mongod', '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--wiredTigerCacheSizeGB', '0.25']);
    await run('registry', ['--network', 'host', '--cpus', '0.25', '--memory', '128m', '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${registryPort}`, 'registry:2']);
    const registry = `127.0.0.1:${registryPort}`;
    await until(async () => { try { return (await fetch(`http://${registry}/v2/`, { signal: AbortSignal.timeout(1000) })).status === 200 ? true : undefined; } catch { return undefined; } });
    await until(async () => { const probe = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, { serverSelectionTimeoutMS: 500 });
      try { await probe.connect(); return (await probe.db('admin').command({ hello: 1 })).isWritablePrimary ? true : undefined; }
      catch { return undefined; } finally { await probe.close(); } });
    await docker(['pull', capabilityImage], 600_000);
    const dockerVersions = JSON.parse(await docker(['version', '--format', '{{json .}}'], 5000));
    report.ownedDockerVersions = { client: dockerVersions.Client?.Version, clientApi: dockerVersions.Client?.ApiVersion,
      server: dockerVersions.Server?.Version, serverApi: dockerVersions.Server?.ApiVersion };
    report.pendingWaitDiagnostics = [];
    report.pendingWaitDiagnosticOverflow = 0;
    report.pendingCreateDiagnostics = [];
    report.pendingCreateDiagnosticOverflow = 0;
    const daemonRead = (endpoint: string, limit: number) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = http.get({ socketPath: '/var/run/owned.sock', path: endpoint, timeout: 1000 }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > limit) request.destroy(new Error('diagnostic byte limit')); else chunks.push(chunk); });
        response.once('end', () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        response.once('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error('diagnostic deadline'))); request.once('error', reject);
    });
    const counterRead = async (filename: string) => {
      const handle = await fs.open(filename, 'r');
      try { const buffer = Buffer.alloc(4096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return Object.fromEntries(buffer.subarray(0, bytesRead).toString('utf8').split('\n')
          .map(line => line.match(/^([A-Za-z_]+):?\s+(\d+)$/)).filter((line): line is RegExpMatchArray => Boolean(line))
          .map(line => [line[1], line[2]]));
      } finally { await handle.close(); }
    };
    const diagnosticTasks = new Set<Promise<void>>();
    probeProxy = await createProbeDaemonProxy(path.join(root, 'probe-daemon-proxy.sock'), '/var/run/owned.sock', cancelBoundary,
      async (containerId, scheduledAfterHeaderMs) => {
        if (report.pendingWaitDiagnostics.length >= 16) { report.pendingWaitDiagnosticOverflow++; return; }
        const record: any = { containerId, scheduledAfterHeaderMs, at: new Date().toISOString(), readOnly: true,
          source: 'private-owned-daemon-unix-socket', status: 'pending' };
        report.pendingWaitDiagnostics.push(record);
        const task = (async () => {
          const results = await Promise.allSettled([
            daemonRead(`/containers/${containerId}/json`, 256 * 1024),
            daemonRead('/debug/pprof/goroutine?debug=2', 1024 * 1024),
            counterRead('/proc/1/io'), counterRead('/sys/fs/cgroup/cpu.stat'), counterRead('/sys/fs/cgroup/memory.events'),
            fs.readFile('/proc/1/comm', 'utf8'),
          ]);
          const inspect = results[0];
          if (inspect.status === 'fulfilled') {
            record.inspectStatus = inspect.value.status;
            if (inspect.value.status === 200) { try { const view = JSON.parse(inspect.value.text); const labels = view.Config?.Labels || {};
              if (view.Id === containerId && ['runtime-validation', 'storage-validation'].includes(labels['cds.agent.probe'])
                && /^[a-f0-9]{32}$/.test(labels['cds.agent.probe.operation']) && /^[a-f0-9]{12}$/.test(labels['cds.instance'])) {
                record.probe = { operationId: labels['cds.agent.probe.operation'], instanceId: labels['cds.instance'], kind: labels['cds.agent.probe'],
                  status: ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(view.State?.Status) ? view.State.Status : 'unknown',
                  running: typeof view.State?.Running === 'boolean' ? view.State.Running : null, dead: typeof view.State?.Dead === 'boolean' ? view.State.Dead : null,
                  exitCode: numericProbeExitCode(String(view.State?.ExitCode ?? '')) };
              }
            } catch { record.inspectParseFailed = true; } }
          } else record.inspectUnavailable = true;
          const stack = results[1];
          if (stack.status === 'fulfilled') { record.stackStatus = stack.value.status;
            if (stack.value.status === 200) record.removalStacks = removalStackSummary(stack.value.text); }
          else record.stackUnavailable = true;
          for (const [index, key] of [[2, 'daemonIo'], [3, 'outerCpu'], [4, 'outerMemoryEvents']] as const) {
            const result = results[index]; record[key] = result.status === 'fulfilled' ? result.value : null;
          }
          record.daemonPid1Verified = results[5].status === 'fulfilled' && results[5].value.trim() === 'dockerd';
          if (!record.daemonPid1Verified) record.daemonIo = null;
          record.status = 'finished'; record.finishedAt = new Date().toISOString();
        })();
        diagnosticTasks.add(task); try { await task; } finally { diagnosticTasks.delete(task); }
      }, async (target, scheduledAfterForwardMs) => {
        if (report.pendingCreateDiagnostics.length >= 4) { report.pendingCreateDiagnosticOverflow++; return; }
        const record: any = { ...target, scheduledAfterForwardMs, at: new Date().toISOString(), readOnly: true,
          source: 'private-owned-daemon-unix-socket', status: 'pending' };
        report.pendingCreateDiagnostics.push(record);
        const task = (async () => {
          const results = await Promise.allSettled([
            daemonRead(`/containers/${encodeURIComponent(target.containerName)}/json`, 256 * 1024),
            daemonRead('/debug/pprof/goroutine?debug=2', 1024 * 1024),
            counterRead('/proc/1/io'), counterRead('/sys/fs/cgroup/cpu.stat'), counterRead('/sys/fs/cgroup/memory.events'),
            fs.readFile('/proc/1/comm', 'utf8'),
          ]);
          const inspect = results[0];
          if (inspect.status === 'fulfilled') {
            record.inspectStatus = inspect.value.status;
            if (inspect.value.status === 200) {
              try {
                const view = JSON.parse(inspect.value.text), labels = view.Config?.Labels || {};
                record.ownedIdentityConfirmed = view.Name === `/${target.containerName}` && /^[a-f0-9]{64}$/.test(view.Id)
                  && view.Config?.Image === target.imageReference && labels['cds.managed'] === 'true' && labels['cds.type'] === 'agent-session'
                  && labels['cds.agent.probe'] === 'runtime-validation' && labels['cds.agent.probe.operation'] === target.operationId
                  && labels['cds.instance'] === target.instanceId;
                if (record.ownedIdentityConfirmed) record.containerId = view.Id;
              } catch { record.inspectParseFailed = true; }
            }
          } else record.inspectUnavailable = true;
          const stack = results[1];
          if (stack.status === 'fulfilled') { record.stackStatus = stack.value.status;
            if (stack.value.status === 200) record.creationStacks = creationStackSummary(stack.value.text); }
          else record.stackUnavailable = true;
          for (const [index, key] of [[2, 'daemonIo'], [3, 'outerCpu'], [4, 'outerMemoryEvents']] as const) {
            const result = results[index]; record[key] = result.status === 'fulfilled' ? result.value : null;
          }
          record.daemonPid1Verified = results[5].status === 'fulfilled' && results[5].value.trim() === 'dockerd';
          if (!record.daemonPid1Verified) record.daemonIo = null;
          record.status = 'finished'; record.finishedAt = new Date().toISOString();
        })();
        diagnosticTasks.add(task); try { await task; } finally { diagnosticTasks.delete(task); }
      });
    // Only observer reads are awaited at outer cleanup; they cannot change the
    // original command deadline, original stop verdict or container removal.
    const originalClose = probeProxy.close;
    probeProxy.close = async () => { await originalClose(); await Promise.allSettled([...diagnosticTasks]); };
    report.cancellationBoundary = cancelBoundary;
    // Check the exact pinned image through the same socket used by the original
    // app before fault injection. This does not replace its own safety probe.
    const proxyHost = `unix://${path.join(root, 'probe-daemon-proxy.sock')}`;
    const directImageId = await docker(['image', 'inspect', capabilityImage, '--format', '{{.Id}}']);
    const proxyImageId = (await execute('docker', ['--host', proxyHost, 'image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
      { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
    assert.equal(proxyImageId, directImageId); assert.match(proxyImageId, /^sha256:[a-f0-9]{64}$/);
    const minimalEnv: NodeJS.ProcessEnv = { DOCKER_HOST: proxyHost };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) minimalEnv[key] = process.env[key];
    const minimalImageId = (await execute('docker', ['image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
      { encoding: 'utf8', timeout: 10_000, env: minimalEnv })).stdout.trim();
    assert.equal(minimalImageId, directImageId);
    report.proxyPinnedImagePreflight = { daemonId: info.ID, imageReference: capabilityImage, imageId: proxyImageId, matchedDirectBackend: true };
    let capabilityProjectId: string | undefined;
    await runApplicationBootstrap({ sourceHead: source.sourceHead, mongoUri: `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, dockerHost: host, output: '/owned/output',
      dockerRequestProxy: { socketPath: path.join(root, 'probe-daemon-proxy.sock'), daemonId: info.ID, owner: source.owner },
      beforeShutdown: async context => {
        report.stage = 'original-application-shutdown-and-restart';
        await checkpoint('before-original-runtime-capability-inflight-cancellation');
        assert.ok(capabilityProjectId);
        // Original periodic reclaim remains enabled. Digest-only unused images
        // can be pruned during the earlier deployment exercise; establish the
        // required image again immediately before this bounded cancellation
        // fault, without replacing the app's own capability safety checks.
        await docker(['pull', capabilityImage], 600_000);
        const preparedImageId = (await execute('docker', ['--host', proxyHost, 'image', 'inspect', capabilityImage, '--format', '{{.Id}}'],
          { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
        assert.equal(preparedImageId, directImageId);
        report.probeImageReadyAtFault = { at: new Date().toISOString(), imageId: preparedImageId, originalReclaimEnabled: true };
        probeProxy!.arm();
        let caught = false; void probeProxy!.caught.then(() => { caught = true; });
        report.capabilityProviderSnapshots = [];
        try {
          // The first read may observe the original startup recovery barrier;
          // keep reading the same public capability entry within the existing
          // 40-second bound, without forcing a refresh or bypassing that barrier.
          await until(async () => {
            const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
            assert.equal(response.status, 200);
            const item = response.json.items.find((item: any) => item.id === 'open-design');
            assert.ok(item); assert.equal(item.healthy, false);
            report.capabilityProviderSnapshots.push({ at: new Date().toISOString(), healthy: item.healthy,
              resourcePolicyEnforcedPerSession: item.resourcePolicyEnforcedPerSession, verificationPending: item.verificationPending,
              reason: item.reason });
            return caught ? true : undefined;
          }, 40_000);
        } finally { report.probeEventsAtCreationBoundary = await context.readProbeEvents(); }
        report.probeApplicationPid = context.applicationPid(); assert.ok(report.probeApplicationPid);
        report.probeApplicationProcessTree = context.applicationProcessTree();
        report.probeFaultInjection = cancelBoundary === 'daemon-created'
          ? 'unchanged original create body forwarded to real owned daemon; original CLI create acknowledgement held until application cancellation after daemon 201'
          : 'unchanged original create body accepted by private Unix proxy; delayed forwarding to real owned daemon after original CLI disconnect';
      },
      afterFirstShutdown: async context => {
        await probeProxy!.settle(); report.probeRequestTimeline = probeProxy!.timeline;
        const request = probeProxy!.timeline.find(event => event.phase === 'original-create-received');
        const reply = probeProxy!.timeline.find(event => event.phase === 'backend-create-replied');
        assert.ok(request && reply); assert.equal(reply.status, 201); assert.match(reply.containerId, /^[a-f0-9]{64}$/);
        if (cancelBoundary === 'daemon-created') {
          const stopped = context.report.shutdownAttempts[0];
          const disconnected = probeProxy!.timeline.find(event => event.phase === 'original-client-disconnected');
          assert.ok(disconnected); assert.ok(reply.at <= stopped.requestedAt && stopped.requestedAt <= disconnected.at);
          assert.equal(stopped.code, 0); assert.ok(stopped.elapsedMs <= 15_000);
          assert.equal(probeProxy!.timeline.some(event => event.phase === 'forward-after-client-disconnect'), false);
        }
        for (const key of ['imageReference', 'cmdHash', 'entrypointHash', 'memoryBytes', 'nanoCpus', 'pidsLimit', 'readonlyRootfs', 'autoRemove', 'networkMode']) {
          assert.equal(request[key === 'imageReference' ? 'image' : key], (expectedCapabilityProbe as any)[key], key);
        }
        const rows = await auditNamespace('after-first-shutdown-before-restart'); assert.equal(rows.some(row => row.id === reply.containerId), false);
        const events = (await context.readProbeEvents()).filter(event => event.operationId === request.operationId);
        const assigned = events.find(event => event.action === 'agent.probe.execution.assigned');
        const acknowledged = events.find(event => event.action === 'agent.probe.creation.acknowledged');
        const cleaned = events.find(event => event.action === 'agent.probe.cleanup.confirmed');
        assert.ok(assigned && acknowledged && cleaned); assert.equal(acknowledged.details.containerId, reply.containerId);
        assert.equal(acknowledged.details.receipt, 'owned-inspect');
        assert.equal(cleaned.details.containerId, reply.containerId);
        assert.equal(assigned.details.executorAssignment.lane, 'operation');
        assert.ok(assigned.details.executorAssignment.factoryGeneration > 0 && assigned.details.executorAssignment.actorPid > 1);
        assert.ok(report.probeApplicationProcessTree.some((row: any) => row.pid === assigned.details.executorAssignment.actorPid));
        assert.ok(report.probeApplicationProcessTree.some((row: any) => row.pid === assigned.details.executorAssignment.factoryPid));
        const daemonEvents = await eventSnapshot('probe-cancel-confirmed-before-restart');
        for (const action of ['create', 'destroy']) assert.ok(daemonEvents.some(event => event.id === reply.containerId
          && event.action === action && event.probeOperationId === request.operationId && event.instanceId === request.instanceId));
        if (cancelBoundary === 'daemon-created') {
          const stopAt = Date.parse(context.report.shutdownAttempts[0].requestedAt);
          assert.ok(Date.parse(cleaned.at) - stopAt >= 0 && Date.parse(cleaned.at) - stopAt <= 10_000);
          const steps = events.filter(event => event.action === 'agent.probe.cleanup.step.requested'); assert.ok(steps.length);
          for (const event of steps) assert.ok(event.details.deadline - event.details.requestedAt > 0
            && event.details.deadline - event.details.requestedAt <= 5000);
          report.actualBudgetProbeCancellationVerified = true;
          context.report.actualBudgetProbeCancellationVerified = true;
        }
        report.originalFirstShutdown = context.report.shutdownAttempts[0];
        report.probeCancellationEvents = events;
        report.checks.push({ name: cancelBoundary === 'daemon-created'
          ? 'original-on-demand-probe-cancel-after-daemon-create-before-CLI-ack-exact-ID-reconciled-before-restart'
          : 'original-on-demand-probe-cancel-late-real-create-exact-ID-reconciled-before-restart', passed: true });
        await checkpoint('original-first-shutdown-and-exact-probe-cleanup-complete');
      },
      afterRestart: async context => {
        await until(async () => { const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
          assert.equal(response.status, 200); const item = response.json.items.find((item: any) => item.id === 'open-design');
          return item?.healthy && item.resourcePolicyEnforcedPerSession ? true : undefined; }, 90_000);
        const rows = await auditNamespace('after-real-normal-capability-validation');
        assert.equal(rows.some(row => row.matchesDefaultRuntimeValidation), false);
        const events = await context.readProbeEvents();
        report.normalCapabilityEvents = events.filter(event => event.action === 'agent.probe.cleanup.confirmed');
        report.coreImageCacheEvents = events.filter(event => event.source === 'core-image-cache');
        const acquired = report.coreImageCacheEvents.filter((event: any) => event.action === 'agent.core-image-cache.acquired');
        assert.ok(acquired.length > 0);
        assert.ok(acquired.every((event: any) => event.details.imageId === directImageId));
        const reference = acquired.at(-1).details.cacheReference;
        assert.equal(await docker(['image', 'inspect', reference, '--format', '{{.Id}}']), directImageId);
        report.originalCoreReferenceConfirmedAfterRestart = { reference, imageId: directImageId, at: new Date().toISOString() };
        assert.ok(report.normalCapabilityEvents.some((event: any) => event.details.probeKind === 'storage-validation'));
        report.checks.push({ name: 'actual-pinned-runtime-CLI-skill-and-hard-storage-validation-remain-available-after-restart', passed: true });
      },
      afterFailedShutdown: async context => {
        // Retain the original failed normal-stop verdict. This additional phase
        // proves whether responsibility survives it; it cannot turn that stop green.
        const originalStop = context.report.shutdownAttempts?.[0];
        assert.equal(originalStop?.code, 1); assert.ok(originalStop.elapsedMs <= 15_000);
        const originalRequest = probeProxy!.timeline.find(event => event.phase === 'original-create-received');
        assert.ok(originalRequest);
        report.failureRecovery = { verdict: 'failed', originalStop, originalNormalStopPassed: false,
          operationId: originalRequest.operationId, instanceId: originalRequest.instanceId, restartRequestedAt: new Date().toISOString() };
        report.probeEventsAtFailedShutdown = await context.readProbeEvents();
        await checkpoint('original-first-shutdown-failed-before-responsibility-recovery');
        await context.restartForFailureRecovery();
        const recoveryTree = context.applicationProcessTree(); report.failureRecovery.processTree = recoveryTree;
        try { await until(async () => { const response = await context.request(`/api/projects/${capabilityProjectId}/agent-runtime-providers`);
          assert.equal(response.status, 200); const item = response.json.items.find((item: any) => item.id === 'open-design');
          return item?.healthy && item.resourcePolicyEnforcedPerSession ? true : undefined; }, 90_000); }
        catch (error) {
          // Run only after the original joint recovery failed; this driver-owned
          // comparison and its cleanup cannot satisfy any original application check.
          probeProxy!.enableTrace();
          await comparePinnedProbe('direct', proxyHost); await comparePinnedProbe('proxy', proxyHost);
          throw error;
        }
        await probeProxy!.settle();
        const reply = probeProxy!.timeline.find(event => event.phase === 'backend-create-replied');
        assert.equal(reply?.status, 201); assert.match(reply!.containerId, /^[a-f0-9]{64}$/);
        const rows = await auditNamespace('after-original-failed-stop-and-application-owned-recovery');
        assert.equal(rows.some(row => row.id === reply!.containerId || row.matchesDefaultRuntimeValidation), false);
        const allEvents = await context.readProbeEvents();
        const recovered = allEvents.filter(event => event.operationId === originalRequest.operationId);
        assert.ok(recovered.some(event => event.action === 'agent.probe.recovery.loaded'));
        assert.ok(recovered.some(event => event.action === 'agent.probe.cleanup.confirmed' && event.details.containerId === reply!.containerId));
        const loadedAt = recovered.findIndex(event => event.action === 'agent.probe.recovery.loaded');
        const removal = recovered.slice(loadedAt).find(event => event.action === 'agent.probe.cleanup.step.assigned' && event.details.cleanupStep === 'remove');
        assert.ok(removal?.details.cleanupExecutorAssignment);
        assert.ok(recoveryTree.some(row => row.pid === removal.details.cleanupExecutorAssignment.actorPid));
        assert.ok(recoveryTree.some(row => row.pid === removal.details.cleanupExecutorAssignment.factoryPid));
        const daemonEvents = await eventSnapshot('application-recovered-failed-probe-before-owned-harness-cleanup');
        for (const action of ['create', 'destroy']) assert.ok(daemonEvents.some(event => event.id === reply!.containerId
          && event.action === action && event.probeOperationId === originalRequest.operationId && event.instanceId === originalRequest.instanceId));
        assert.ok(allEvents.some(event => event.action === 'agent.probe.cleanup.confirmed' && event.details.probeKind === 'storage-validation'));
        report.failureRecovery.events = recovered; report.failureRecovery.normalCapabilityEvents = allEvents.filter(event => event.action === 'agent.probe.cleanup.confirmed');
        report.failureRecovery.shutdown = await context.stopForFailureRecovery(); // Original code0/15s, reused verbatim.
        report.failureRecovery.verdict = 'passed'; report.failureRecovery.finishedAt = new Date().toISOString();
        report.checks.push({ name: 'separate-failed-stop-owned-recovery-and-original-normal-capability-validation', passed: true,
          originalNormalStopPassed: false });
      },
      exercise: async (context: ApplicationBootstrapContext) => {
        const { request, requestRaw } = context;
        report.stage = 'real-project-create';
        const compose = 'services:\n' + ['api', 'web', 'worker'].map(role => `  ${role}:\n    image: "${registry}/owned-${role === 'web' ? 'web' : 'api'}:sha-\${CDS_COMMIT_SHA}"\n    ports: ["8080"]\n    environment:\n      SERVICE_NAME: "${role}"\n    labels:\n      cds.prebuilt-image: "true"\n      cds.subdomain: "${role}"\n      cds.readiness-path: "/"\n      cds.readiness-timeout: "30"\n`).join('');
        const created = await request('/api/projects', 'POST', { name: '完整应用隔离部署前提', slug: source.owner.replaceAll('_', '-'), composeYaml: compose,
          projectFiles: [{ relativePath: 'marker.txt', content: 'old-fixture' }] });
        assert.equal(created.status, 201, created.text); assert.equal(created.json.sandbox, true); const projectId = created.json.project.id; assert.ok(projectId); capabilityProjectId = projectId;
        const projectRepo = path.join(context.root, 'repos', projectId); assert.ok((await fs.stat(projectRepo)).isDirectory());
        const git = async (args: string[]) => (await execute('/usr/bin/git', ['-C', projectRepo, ...args], { encoding: 'utf8', timeout: 5000 })).stdout.trim();
        const fixtureBranch = 'pending-proof'; const fixtureDefaultBranch = await git(['symbolic-ref', '--short', 'HEAD']);
        assert.notEqual(fixtureDefaultBranch, fixtureBranch); await git(['branch', fixtureBranch]);
        const oldSha = await git(['rev-parse', 'HEAD']); assert.match(oldSha, /^[a-f0-9]{40}$/);
        const profilesResponse = await request(`/api/build-profiles?project=${encodeURIComponent(projectId)}`); assert.equal(profilesResponse.status, 200);
        const profiles = profilesResponse.json.profiles; assert.equal(profiles.length, 3);
        assert.equal(profiles.every((p: any) => p.prebuiltImage === true && !p.localArtifact && !p.managedBuild), true);
        const branchResponse = await request('/api/branches', 'POST', { projectId, branch: fixtureBranch }); assert.equal(branchResponse.status, 201, branchResponse.text);
        const branchId = branchResponse.json.branch.id; assert.ok(branchId); const branchPath = `/api/branches/${encodeURIComponent(branchId)}`;
        const runsPath = `/api/deployment-runs?project=${encodeURIComponent(projectId)}&branch=${encodeURIComponent(branchId)}`;
        const readRuns = async () => { const response = await request(runsPath); assert.equal(response.status, 200, response.text); report.lastRunsResponse = { status: response.status, runs: response.json.runs }; return response.json.runs as any[]; };
        const branch = async () => { const response = await request(branchPath); assert.equal(response.status, 200, response.text); return response.json.branch; };
        report.project = { projectId, branchId, profiles: profiles.map((p: any) => ({ id: p.id, prebuiltImage: p.prebuiltImage, dockerImage: p.dockerImage })), sourceOld: oldSha, fixtureBranch, fixtureDefaultBranch };
        report.checks.push({ name: 'original-authenticated-project-compose-and-branch-worktree-entry', passed: true });
        const began = Math.floor(Date.now() / 1000) - 1;
        await build('api', oldSha, registry); await build('web', oldSha, registry);
        const serviceProof = async (expected: string | Record<string, string>, previousIds?: Record<string, string>) => {
          const current = await branch(); const services = Object.entries(current.services) as Array<[string, any]>; assert.equal(services.length, 3);
          const result: Record<string, any> = {};
          for (const [profileId, service] of services) {
            const sha = typeof expected === 'string' ? expected : expected[profileId]; assert.match(sha, /^[a-f0-9]{40}$/);
            assert.equal(service.status, 'running'); const view = await ownedView(service.containerName); containers.add(view.Id);
            assert.equal(view.State.Running, true); assert.notEqual(view.HostConfig.NetworkMode, 'host'); assert.notEqual(view.HostConfig.NetworkMode, 'bridge');
            assert.equal(view.Config.Labels['org.opencontainers.image.revision'], sha);
            const response = await fetch(`http://127.0.0.1:${service.hostPort}/`, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200);
            const content: any = await response.json(); assert.equal(content.source, sha); assert.equal(content.runtime, sha);
            assert.equal(content.service, profiles.find((p: any) => p.id === profileId).env.SERVICE_NAME);
            if (previousIds) assert.equal(view.Id, previousIds[profileId]);
            result[profileId] = { id: view.Id, containerName: view.Name.slice(1), image: view.Image, startedAt: view.State.StartedAt, hostPort: service.hostPort, network: view.HostConfig.NetworkMode, content };
          }
          return result;
        };
        report.stage = 'original-deploy-old-fixture';
        const initial = await requestRaw(`${branchPath}/deploy`, { commitSha: oldSha }); assert.equal(initial.status, 200);
        const initialId = initial.headers.get('x-cds-deployment-run-id'); assert.ok(initialId); report.initialDeployment = { id: initialId, status: initial.status, stream: (await initial.text()).slice(-32768) };
        await until(async () => { const run = (await readRuns()).find(r => r.id === initialId); if (run?.status === 'failed') throw new Error(`原应用首次部署失败: ${JSON.stringify(run).slice(0, 2000)}`); return run?.status === 'running' ? true : undefined; });
        const oldServices = await serviceProof(oldSha); report.oldServices = oldServices; await auditNamespace('original-old-services-ready');
        const oldImages = Object.values(oldServices) as any[];
        const webImage = oldImages.find(s => s.content.service === 'web').image;
        assert.equal(oldImages.filter(s => s.content.service !== 'web').every(s => s.image !== webImage), true);
        const oldIds = Object.fromEntries(Object.entries(oldServices).map(([id, value]: [string, any]) => [id, value.id]));
        await fs.writeFile(path.join(projectRepo, 'marker.txt'), 'new-fixture'); await git(['add', 'marker.txt']); await git(['commit', '-m', '隔离部署新目标']);
        const newSha = await git(['rev-parse', 'HEAD']); assert.notEqual(newSha, oldSha); assert.match(newSha, /^[a-f0-9]{40}$/); report.project.sourceNew = newSha;
        await git(['branch', '-f', fixtureBranch, newSha]); assert.equal(await git(['rev-parse', fixtureBranch]), newSha);
        assert.equal(await git(['symbolic-ref', '--short', 'HEAD']), fixtureDefaultBranch);
        report.stage = 'missing-required-artifact-wait';
        // 原只读 API 短时样本；它不是30分钟性能窗口，全部错误原样计入。
        const reads: any[] = []; let stopReads = false;
        const sampler = (async () => { while (!stopReads) {
          for (const endpoint of ['/api/branches', runsPath, '/healthz']) {
            const started = performance.now(); try { const r = await request(endpoint); reads.push({ endpoint, at: new Date().toISOString(), status: r.status, elapsedMs: r.elapsedMs }); }
            catch (error) { reads.push({ endpoint, at: new Date().toISOString(), elapsedMs: performance.now() - started, error: String((error as Error).message) }); }
          }
          await sleep(1000);
        } })();
        try {
          const queued = await requestRaw(`${branchPath}/deploy`, { commitSha: newSha }); const text = await queued.text(); assert.ok([200, 202].includes(queued.status), text);
          const queuedId = queued.headers.get('x-cds-deployment-run-id'); assert.ok(queuedId); report.queuedDeployment = { id: queuedId, status: queued.status, stream: text.slice(-32768) };
          await until(async () => { const run = (await readRuns()).find(r => r.id === queuedId); return run?.status === 'queued' && run.phase === 'artifact-wait' ? run : undefined; });
          const duplicate = await requestRaw(`${branchPath}/deploy`, { commitSha: newSha }); const repeatedText = await duplicate.text(); assert.ok([200, 202].includes(duplicate.status), repeatedText);
          assert.equal(duplicate.headers.get('x-cds-deployment-run-id'), queuedId); report.duplicateDeployment = { id: queuedId, status: duplicate.status, stream: repeatedText.slice(-32768) };
          await serviceProof(oldSha, oldIds);
          assert.equal((await readRuns()).filter(r => r.commitSha === newSha).length, 1);
          report.checks.push({ name: 'complete-application-missing-wait-retains-real-old-http-and-duplicate-run', passed: true });
          report.stage = 'publish-all-required-and-original-watchdog-resume';
          await build('api', newSha, registry); await build('web', newSha, registry);
          await until(async () => { const run = (await readRuns()).find(r => r.id === queuedId);
            if (run?.status === 'failed') throw new Error(`原应用发布后恢复失败: ${JSON.stringify(run).slice(0, 2000)}`);
            return run?.status === 'running' ? run : undefined;
          }, 180_000);
          report.newServices = await serviceProof(newSha); report.finalRuns = await readRuns(); await auditNamespace('original-new-services-ready');
          assert.equal(report.finalRuns.filter((r: any) => r.commitSha === newSha).length, 1);
          const events = (await docker(['events', '--since', String(began), '--until', String(Math.ceil(Date.now() / 1000)), '--format', '{{json .}}']))
            .split('\n').filter(Boolean).map(line => JSON.parse(line));
          const ownedStarts = events.filter((e: any) => e.Type === 'container' && e.Action === 'start' && e.Actor?.Attributes?.['cds.acceptance.owner'] === source.owner);
          // Mongo/registry在窗口之前启动；六次实际应用start证明重复等待没有新增执行。
          assert.equal(ownedStarts.length, 6, JSON.stringify(ownedStarts)); report.actualApplicationStartEvents = ownedStarts;
          const shared = Object.values(report.newServices).filter((s: any) => s.content.service !== 'web') as any[];
          assert.equal(shared.length, 2); assert.equal(shared[0].image, shared[1].image);
          report.checks.push({ name: 'original-watchdog-resumes-confirmed-run-once-and-shared-worker-reuses-api-image', passed: true });
          const dispatchProof = async (issuer: 'routes' | 'index', sha: string, runId: string) => {
            return until(async () => {
              const trace = await context.readDispatchEvents(projectId, branchId);
              const dispatched = trace.filter(event => event.action === 'branch.operation.pending-dispatch.started' && event.commitSha === sha);
              if (dispatched.length === 0) return undefined;
              assert.equal(dispatched.length, 1); const dispatch = dispatched[0];
              assert.equal(Object.hasOwn(dispatch.details, 'mergedCount'), issuer === 'routes');
              if (issuer === 'routes') assert.ok(dispatch.details.mergedCount >= 1);
              const run = (await readRuns()).find(item => item.id === runId); assert.ok(run);
              assert.equal(run.operationId, dispatch.operationId); assert.equal(run.commitSha, sha);
              const accepted = trace.filter(event => event.action === 'branch.operation.started'
                && event.operationId === dispatch.operationId && event.details.replayOf?.operationId === dispatch.operationId);
              if (accepted.length === 0) return undefined; assert.equal(accepted.length, 1);
              assert.equal(accepted[0].details.replayOf.generation, run.operationGeneration);
              assert.equal(accepted[0].projectId, projectId); assert.equal(accepted[0].branchId, branchId);
              assert.equal(accepted[0].commitSha, sha);
              const completed = trace.find(event => event.action === 'branch.operation.completed' && event.operationId === dispatch.operationId);
              if (!completed) return undefined;
              assert.equal(trace.some(event => event.action === 'branch.operation.pending-dispatch.failed' && event.operationId === dispatch.operationId), false);
              return { issuer, fixedSourceEventDiscriminator: issuer === 'routes' ? 'mergedCount-present' : 'mergedCount-absent',
                deploymentRunId: runId, operationId: dispatch.operationId, projectId, branchId, commitSha: sha,
                dispatch, accepted: accepted[0], completed, originalEvents: trace };
            }, 10_000);
          };
          report.actualPendingDispatchers = { routes: await dispatchProof('routes', newSha, queuedId) };
          report.stage = 'original-scheduler-cooling-queues-next-target';
          await fs.writeFile(path.join(projectRepo, 'marker.txt'), 'background-dispatch-fixture');
          await git(['add', 'marker.txt']); await git(['commit', '-m', '隔离后台派发目标']);
          const backgroundSha = await git(['rev-parse', 'HEAD']); assert.notEqual(backgroundSha, newSha);
          report.project.sourceBackground = backgroundSha;
          await git(['branch', '-f', fixtureBranch, backgroundSha]); assert.equal(await git(['rev-parse', fixtureBranch]), backgroundSha);
          assert.equal(await git(['symbolic-ref', '--short', 'HEAD']), fixtureDefaultBranch);
          await build('api', backgroundSha, registry); await build('web', backgroundSha, registry);
          const current = await branch();
          const firstService = Object.values(current.services).find((service: any) => service.status === 'running') as any;
          assert.ok(firstService); const view = await ownedView(firstService.containerName);
          assert.equal(view.State.Running, true);
          const initialScheduler = await request('/api/scheduler/state'); assert.equal(initialScheduler.status, 200);
          assert.equal(initialScheduler.json.enabled, false);
          const gate = probeProxy!.holdNextStop(firstService.containerName);
          let cooling: Promise<Response> | undefined, queuedBackgroundId: string | null = null;
          try {
            const enabled = await request('/api/scheduler/enabled', 'PUT', { enabled: true }); assert.equal(enabled.status, 200);
            const state = await request('/api/scheduler/state'); assert.equal(state.status, 200);
            const selected = [...state.json.hot, ...state.json.cold].find((item: any) => item.slug === branchId);
            assert.ok(selected); assert.equal(selected.pinned, false);
            report.backgroundCoolingRequest = { path: `/api/scheduler/cool/${encodeURIComponent(branchId)}`,
              at: new Date().toISOString(), controlledAuthenticatedUserRequest: true, genuineIdleTickVerified: false,
              exactContainerId: view.Id, exactContainerName: firstService.containerName, branchName: fixtureBranch };
            cooling = requestRaw(report.backgroundCoolingRequest.path); void cooling.catch(() => {});
            const held = await until(async () => Promise.race([gate.caught, Promise.resolve(undefined)]), 45_000);
            assert.equal(held.status, 204); assert.equal((await ownedView(firstService.containerName)).State.Running, false);
            const beforeQueue = await context.readDispatchEvents(projectId, branchId);
            const active = beforeQueue.filter(event => event.action === 'branch.operation.started' && event.operationKind === 'scheduler-cooling');
            assert.equal(active.length, 1); assert.equal(active[0].operationSource, 'schedulerService.setCoolFn');
            report.backgroundCoolingLease = active[0];
            // Controlled authenticated trigger, never a real GitHub event or a
            // forged internal replay. The original index signs the later replay.
            const pending = await requestRaw(`${branchPath}/deploy`, { commitSha: backgroundSha }, 'webhook');
            const pendingText = await pending.text(); assert.ok([200, 202].includes(pending.status), pendingText);
            const payloads = pendingText.trim().startsWith('{') ? [JSON.parse(pendingText)]
              : pendingText.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
            const merged = payloads.find(payload => payload.operationStatus === 'merged'); assert.ok(merged, pendingText);
            assert.equal(merged.activeOperationId, active[0].operationId);
            queuedBackgroundId = pending.headers.get('x-cds-deployment-run-id'); assert.ok(queuedBackgroundId);
            report.backgroundQueuedDeployment = { id: queuedBackgroundId, status: pending.status, accepted: merged,
              controlledAuthenticatedTrigger: 'webhook', genuineGitHubEventVerified: false, originalCoolingReply: held };
            assert.equal(gate.expired(), false);
          } catch (error) {
            try { const observed = await branch();
              report.backgroundFailureDiagnostics = { at: new Date().toISOString(), branchId, status: observed.status,
                heatState: observed.heatState, services: Object.values(observed.services).map((service: any) => ({
                  profileId: service.profileId, status: service.status, containerName: service.containerName })),
                events: await context.readDispatchEvents(projectId, branchId) };
            } catch (diagnosticsError) { report.backgroundFailureDiagnostics = { captureError: String(diagnosticsError).slice(0, 2000) }; }
            throw error;
          } finally {
            gate.release();
            try { if (cooling) { const response = await cooling; const text = await response.text();
              report.backgroundCoolingResponse = { status: response.status, at: new Date().toISOString(), body: JSON.parse(text) };
              assert.equal(response.status, 200, text); assert.equal(report.backgroundCoolingResponse.body.heatState, 'cold');
            } } finally {
              const restored = await request('/api/scheduler/enabled', 'PUT', { enabled: initialScheduler.json.enabled });
              report.schedulerPrivateToggleRestored = { status: restored.status, enabled: restored.json.enabled };
              assert.equal(restored.status, 200); assert.equal(restored.json.enabled, false);
            }
          }
          assert.ok(queuedBackgroundId);
          await until(async () => { const run = (await readRuns()).find(item => item.id === queuedBackgroundId);
            if (run?.status === 'failed') throw new Error(`原后台派发部署失败: ${JSON.stringify(run).slice(0, 2000)}`);
            return run?.status === 'running' ? true : undefined; }, 180_000);
          report.backgroundServices = await serviceProof(backgroundSha);
          report.actualPendingDispatchers.index = await dispatchProof('index', backgroundSha, queuedBackgroundId);
          const coolingCompleted = report.actualPendingDispatchers.index.originalEvents.find((event: any) => event.action === 'branch.operation.completed'
            && event.operationId === report.backgroundCoolingLease.operationId);
          assert.ok(coolingCompleted);
          assert.ok(Date.parse(coolingCompleted.at) <= Date.parse(report.actualPendingDispatchers.index.dispatch.at));
          assert.equal((await readRuns()).filter(item => item.commitSha === backgroundSha).length, 1);
          report.actualBothPendingDispatchersVerified = true;
          context.report.actualBothPendingDispatchersVerified = true;
          report.checks.push({ name: 'two-original-signed-loopback-pending-dispatchers-bound-to-real-replay-lease-and-container-revisions', passed: true });
        } finally { stopReads = true; await sampler; report.readSamples = reads; }
        assert.ok(report.readSamples.length >= 3); assert.equal(report.readSamples.every((r: any) => r.status === 200 && !r.error), true, JSON.stringify(report.readSamples.filter((r: any) => r.status !== 200 || r.error)));
        report.checks.push({ name: 'original-list-task-and-full-health-short-window-requests-returned', passed: true });
        probeProxy!.enableTrace();
        report.stage = 'full-application-service-target-replacement-and-inflight-stop';
        const scopeProof: any = report.serviceTargetReplacement = { genericFixtureOnly: true,
          representativeBusinessCiVerified: false, controlledAuthenticatedUserRequests: true,
          manualStopIntentionallyStopsAllServices: true, originalEvents: [], verdict: 'failed' };
        try {
          const apiProfile = profiles.find((profile: any) => profile.env.SERVICE_NAME === 'api');
          const webProfile = profiles.find((profile: any) => profile.env.SERVICE_NAME === 'web');
          const workerProfile = profiles.find((profile: any) => profile.env.SERVICE_NAME === 'worker');
          assert.ok(apiProfile && webProfile && workerProfile);
          const baseline = await serviceProof(report.project.sourceBackground);
          const targets: Record<string, string> = {};
          for (const label of ['active', 'obsolete', 'latest', 'cancelled']) {
            await fs.writeFile(path.join(projectRepo, 'marker.txt'), `service-target-${label}`);
            await git(['add', 'marker.txt']); await git(['commit', '-m', `隔离服务范围目标${label}`]);
            const sha = await git(['rev-parse', 'HEAD']); assert.match(sha, /^[a-f0-9]{40}$/);
            await git(['branch', '-f', fixtureBranch, sha]); assert.equal(await git(['rev-parse', fixtureBranch]), sha);
            assert.equal(await git(['symbolic-ref', '--short', 'HEAD']), fixtureDefaultBranch);
            targets[label] = sha; await build('api', sha, registry); await build('web', sha, registry);
          }
          assert.equal(new Set(Object.values(targets)).size, 4); scopeProof.targets = targets;
          const registryDigest = (image: any): string => {
            const references = image.repoDigests.filter((reference: string) => reference.startsWith(`${registry}/owned-`));
            assert.equal(references.length, 1); assert.match(references[0], /@sha256:[a-f0-9]{64}$/); return references[0];
          };
          const apiImage = (sha: string) => {
            const image = report.publishedImages.find((item: any) => item.role === 'api' && item.sha === sha); assert.ok(image); return image;
          };
          const startTarget = (sha: string) => ({ projectId, branchId, profileId: apiProfile.id, imageReference: registryDigest(apiImage(sha)) });
          const heldStartProof = async (held: Awaited<ReturnType<NonNullable<typeof probeProxy>['holdNextAppStart']>['caught']>, sha: string) => {
            assert.equal(held.status, 204); assert.equal(held.imageReference, registryDigest(apiImage(sha)));
            const view = await ownedView(held.containerId); containers.add(view.Id);
            assert.equal(view.Id, held.containerId); assert.equal(view.Name.slice(1), held.containerName); assert.equal(view.State.Running, true);
            for (const [key, value] of Object.entries({ 'cds.managed': 'true', 'cds.type': 'app', 'cds.project.id': projectId,
              'cds.branch.id': branchId, 'cds.profile.id': apiProfile.id, 'org.opencontainers.image.revision': sha })) assert.equal(view.Config.Labels[key], value);
            assert.equal(view.Image, apiImage(sha).id); assert.equal(view.Config.Image, held.imageReference);
            assert.ok(held.startReference === view.Id || held.startReference === held.containerName);
            if (held.startReference === held.containerName) {
              assert.equal(held.namedIdentityConfirmed, true);
              const identity = probeProxy!.timeline.filter(event => event.phase === 'original-app-named-start-identity-confirmed'
                && event.containerId === view.Id && event.startReference === held.containerName);
              assert.equal(identity.length, 1); assert.equal(identity[0].status, 200);
            }
            assert.equal(view.Config.Env.filter((value: string) => value.startsWith('CDS_COMMIT_SHA=')).join(''), `CDS_COMMIT_SHA=${sha}`);
            assert.ok(Date.parse(view.State.StartedAt) <= Date.parse(held.at));
            const created = probeProxy!.timeline.filter(event => event.phase === 'original-app-create-replied' && event.containerId === view.Id);
            assert.equal(created.length, 1); assert.equal(created[0].projectId, projectId); assert.equal(created[0].branchId, branchId);
            assert.equal(created[0].profileId, apiProfile.id); assert.equal(created[0].imageReference, held.imageReference);
            return { held, originalCreate: created[0], containerId: view.Id, imageId: view.Image, startedAt: view.State.StartedAt,
              actualRunningBeforeOriginalCliAcknowledgment: true };
          };
          const profilePath = (id: string) => `${branchPath}/deploy/${encodeURIComponent(id)}`;
          const queued = async (profileId: string, sha: string, status: 'merged' | 'joined') => {
            const response = await requestRaw(profilePath(profileId), { commitSha: sha }, 'webhook');
            const body = await response.text(); assert.equal(response.status, 200, body);
            const complete = body.match(/event: complete\r?\ndata: ([^\r\n]+)/); assert.ok(complete, body);
            const payload = JSON.parse(complete[1]); assert.equal(payload.ok, true);
            assert.equal(payload.operationStatus, status); assert.equal(payload.pendingCommitSha, sha);
            const id = response.headers.get('x-cds-deployment-run-id'); assert.ok(id);
            assert.equal(payload.deploymentRunId, id); return { id, profileId, sha, status: response.status, payload };
          };
          const gate = probeProxy!.holdNextAppStart(startTarget(targets.active));
          let active: Response | undefined, activeId: string | null = null;
          try {
            active = await requestRaw(profilePath(apiProfile.id), { commitSha: targets.active });
            assert.equal(active.status, 200); activeId = active.headers.get('x-cds-deployment-run-id'); assert.ok(activeId);
            const held = await until(async () => Promise.race([gate.caught, Promise.resolve(undefined)]), 45_000);
            scopeProof.activeStart = await heldStartProof(held, targets.active);
            const oldApi = await queued(apiProfile.id, targets.obsolete, 'merged');
            const duplicate = await queued(apiProfile.id, targets.obsolete, 'joined'); assert.equal(duplicate.id, oldApi.id);
            const web = await queued(webProfile.id, targets.obsolete, 'merged');
            const latestApi = await queued(apiProfile.id, targets.latest, 'merged');
            assert.notEqual(web.id, oldApi.id); assert.notEqual(latestApi.id, oldApi.id);
            const runs = await readRuns();
            assert.equal(runs.find(run => run.id === oldApi.id)?.status, 'cancelled');
            for (const item of [web, latestApi]) {
              const run = runs.find(row => row.id === item.id); assert.equal(run?.status, 'queued');
              assert.equal(run.commitSha, item.sha); assert.equal(run.profileId, item.profileId);
            }
            scopeProof.accepted = { activeId, oldApi, duplicate, web, latestApi, held, runs };
            assert.equal(gate.expired(), false);
          } finally { gate.release(); }
          assert.ok(active); scopeProof.activeStream = (await active.text()).slice(-32768);
          const { web, latestApi, oldApi } = scopeProof.accepted;
          await until(async () => {
            const runs = await readRuns();
            for (const id of [activeId, web.id, latestApi.id]) {
              const run = runs.find(row => row.id === id);
              if (run?.status === 'failed' || run?.status === 'cancelled') throw new Error(`原服务范围部署失败: ${JSON.stringify(run).slice(0, 2000)}`);
            }
            return [activeId, web.id, latestApi.id].every(id => runs.find(row => row.id === id)?.status === 'running') ? true : undefined;
          }, 180_000);
          const mixed = await serviceProof({ [apiProfile.id]: targets.latest, [webProfile.id]: targets.obsolete,
            [workerProfile.id]: report.project.sourceBackground });
          assert.equal(mixed[workerProfile.id].id, baseline[workerProfile.id].id);
          const runs = await readRuns(); assert.equal(runs.find(row => row.id === oldApi.id)?.status, 'cancelled');
          assert.equal(runs.filter(row => row.commitSha === targets.obsolete && row.profileId === apiProfile.id).length, 1);
          const daemonEvents = await eventSnapshot('full-original-application-service-target-replacement');
          const apiObsolete = report.publishedImages.find((image: any) => image.role === 'api' && image.sha === targets.obsolete);
          const webObsolete = report.publishedImages.find((image: any) => image.role === 'web' && image.sha === targets.obsolete);
          const apiLatest = report.publishedImages.find((image: any) => image.role === 'api' && image.sha === targets.latest);
          assert.ok(apiObsolete && webObsolete && apiLatest);
          const creations = daemonEvents.filter(event => event.action === 'create');
          assert.equal(creations.filter(event => event.image === registryDigest(apiObsolete)).length, 0);
          const apiActive = report.publishedImages.find((image: any) => image.role === 'api' && image.sha === targets.active); assert.ok(apiActive);
          // Docker retains a finite event history. The first executing target
          // must still be present, so absence of the later queued target is
          // not inferred from a window whose beginning has already rolled off.
          for (const image of [apiActive, webObsolete, apiLatest]) assert.equal(creations.filter(event => event.image === registryDigest(image)).length, 1);
          scopeProof.mixedServices = mixed; scopeProof.replacementRuns = runs; scopeProof.creationEvents = creations;
          report.checks.push({ name: 'full-original-authenticated-application-replaces-only-obsolete-service-target-and-retains-distinct-service-and-worker', passed: true });

          // Explicit user stop is the original higher-priority intent; it may
          // stop the whole branch. This is not a failed-build old-service test.
          const cancelGate = probeProxy!.holdNextAppStart(startTarget(targets.cancelled));
          let cancelled: Response | undefined, cancelId: string | null = null;
          let stop: Promise<Response> | undefined;
          try {
            cancelled = await requestRaw(profilePath(apiProfile.id), { commitSha: targets.cancelled });
            assert.equal(cancelled.status, 200); cancelId = cancelled.headers.get('x-cds-deployment-run-id'); assert.ok(cancelId);
            const held = await until(async () => Promise.race([cancelGate.caught, Promise.resolve(undefined)]), 45_000);
            scopeProof.cancelStart = await heldStartProof(held, targets.cancelled);
            const activeRun = (await readRuns()).find(row => row.id === cancelId);
            assert.equal(activeRun.commitSha, targets.cancelled); assert.equal(activeRun.profileId, apiProfile.id);
            assert.ok(['preparing', 'building', 'starting', 'verifying'].includes(activeRun.status));
            const started = (await context.readDispatchEvents(projectId, branchId)).filter(event => event.action === 'branch.operation.started'
              && event.operationKind === 'deploy-profile' && event.operationId === activeRun.operationId
              && event.details.generation === activeRun.operationGeneration && event.commitSha === targets.cancelled);
            // The original authenticated entry admits a logical operation,
            // then its signed dispatch resumes the same lease. Both markers
            // must remain visible; neither is a second deployment execution.
            assert.equal(started.length, 2);
            const admitted = started.filter(event => event.details.replayOf === null);
            const resumed = started.filter(event => event.details.replayOf?.operationId === activeRun.operationId
              && event.details.replayOf?.generation === activeRun.operationGeneration);
            assert.equal(admitted.length, 1); assert.equal(resumed.length, 1);
            for (const event of started) {
              assert.equal(event.profileId, apiProfile.id); assert.equal(event.projectId, projectId);
              assert.equal(event.branchId, branchId); assert.equal(event.operationSource, 'api.deploy-profile');
              assert.equal(event.operationTrigger, 'manual');
            }
            assert.ok(Date.parse(admitted[0].at) <= Date.parse(resumed[0].at));
            assert.equal((await readRuns()).filter(row => row.commitSha === targets.cancelled && row.profileId === apiProfile.id).length, 1);
            scopeProof.activeCancellationStarted = { admitted: admitted[0], resumed: resumed[0] };
            stop = requestRaw(`${branchPath}/stop`); void stop.catch(() => {});
            await until(async () => (await readRuns()).find(row => row.id === cancelId)?.status === 'cancelled' ? true : undefined, 5000);
            assert.equal(cancelGate.expired(), false);
            scopeProof.activeCancellation = { id: cancelId, profileId: apiProfile.id, sha: targets.cancelled, held, activeRun };
          } finally { cancelGate.release(); }
          assert.ok(cancelled);
          const stopped = await stop; const stopText = await stopped.text(); assert.equal(stopped.status, 200, stopText);
          scopeProof.activeCancellation.stop = { status: stopped.status, body: JSON.parse(stopText) };
          scopeProof.activeCancellation.stream = (await cancelled.text()).slice(-32768);
          const cancelledRun = (await readRuns()).find(row => row.id === cancelId); assert.equal(cancelledRun?.status, 'cancelled');
          scopeProof.activeCancellation.finalRun = cancelledRun;
          const cancellationEvents = await eventSnapshot('full-original-authenticated-application-active-stop');
          const cancelCid = scopeProof.cancelStart.containerId;
          const cancelledImage = apiImage(targets.cancelled);
          const createdTarget = cancellationEvents.filter(event => event.type === 'container' && event.action === 'create'
            && event.id === cancelCid && event.image === registryDigest(cancelledImage));
          assert.equal(createdTarget.length, 1);
          assert.equal(cancellationEvents.filter(event => event.type === 'container' && event.action === 'start' && event.id === cancelCid).length, 1);
          const actualCancelled = await daemonRead(`/containers/${cancelCid}/json`, 256 * 1024);
          let disposition: 'removed' | 'stopped-retained-by-user-stop';
          if (actualCancelled.status === 404) {
            const missing = JSON.parse(actualCancelled.text); assert.match(String(missing.message), /No such container:/);
            assert.ok(String(missing.message).includes(cancelCid)); disposition = 'removed';
            assert.ok(cancellationEvents.some(event => event.type === 'container' && event.action === 'destroy' && event.id === cancelCid));
          } else {
            assert.equal(actualCancelled.status, 200); const view = JSON.parse(actualCancelled.text);
            assert.equal(view.Id, cancelCid); assert.equal(view.Config.Labels['cds.project.id'], projectId);
            assert.equal(view.Config.Labels['cds.branch.id'], branchId); assert.equal(view.Config.Labels['cds.profile.id'], apiProfile.id);
            assert.equal(view.Config.Labels['org.opencontainers.image.revision'], targets.cancelled);
            assert.equal(view.State.Running, false); assert.equal(view.State.Status, 'exited');
            assert.ok(cancellationEvents.some(event => event.type === 'container' && event.action === 'stop' && event.id === cancelCid));
            disposition = 'stopped-retained-by-user-stop';
          }
          const stoppedBranch = await branch(); assert.equal(stoppedBranch.status, 'idle');
          assert.equal(Object.values(stoppedBranch.services).every((service: any) => service.status === 'stopped'), true);
          scopeProof.activeCancellation.actualDaemonDisposition = { containerId: cancelCid, status: actualCancelled.status, disposition,
            noRunningCancelledContainer: true, sourceSha: targets.cancelled };
          scopeProof.activeCancellation.finalBranch = { status: stoppedBranch.status, services: Object.values(stoppedBranch.services)
            .map((service: any) => ({ profileId: service.profileId, status: service.status, containerName: service.containerName })) };
          scopeProof.originalEvents = await context.readDispatchEvents(projectId, branchId);
          assert.ok(scopeProof.originalEvents.some((event: any) => event.action === 'branch.operation.started'
            && event.operationKind === 'stop' && event.operationSource === 'api.stop-branch'));
          // Restore the preceding complete target via the original authenticated
          // entry, so later infra/core experiments keep their original inputs.
          const restore = await requestRaw(`${branchPath}/deploy`, { commitSha: report.project.sourceBackground });
          const restoreId = restore.headers.get('x-cds-deployment-run-id'); assert.ok(restoreId); assert.equal(restore.status, 200);
          scopeProof.restoration = { id: restoreId, stream: (await restore.text()).slice(-32768) };
          await until(async () => (await readRuns()).find(row => row.id === restoreId)?.status === 'running' ? true : undefined, 180_000);
          scopeProof.restoration.services = await serviceProof(report.project.sourceBackground);
          scopeProof.verdict = 'passed'; scopeProof.finishedAt = new Date().toISOString();
          report.checks.push({ name: 'full-original-authenticated-higher-priority-stop-cancels-daemon-started-service-and-original-deploy-restores', passed: true });
          await checkpoint('original-authenticated-service-scope-cancel-and-restoration-complete');
        } catch (error) {
          scopeProof.failure = { at: new Date().toISOString(), message: String((error as Error).message).slice(0, 2000) };
          try { scopeProof.originalEvents = await context.readDispatchEvents(projectId, branchId); scopeProof.failureRuns = await readRuns(); }
          catch (captureError) { scopeProof.captureError = String(captureError).slice(0, 2000); }
          throw error;
        }
        report.stage = 'original-infra-observation-and-recovery';
        const loopbackAddresses = Object.values(os.networkInterfaces()).flat().filter(address => address?.internal
          && address.family === 'IPv4').map(address => address!.address);
        assert.ok(loopbackAddresses.includes('127.0.0.1'));
        report.infraPublishFixtureInput = { origin: 'private-application-process', key: 'CDS_INFRA_PUBLISH_HOST',
          value: '127.0.0.1', actualLoopbackVerified: true, sharedConfigurationChanged: false, applicationConsumerConnectivityVerified: false };
        const infraId = 'owned-observation', infraSha = report.project.sourceBackground;
        const infraHealthPath = `/api/infra/${infraId}/health?project=${encodeURIComponent(projectId)}`;
        let infraCreated = false; let infraScenarioFailure: unknown;
        try {
          const createdInfra = await request('/api/infra', 'POST', { id: infraId, projectId, dockerImage: `${registry}/owned-api:sha-${infraSha}`,
            containerPort: 8080, volumes: [], restartPolicy: 'no', env: { SERVICE_NAME: 'infra', CDS_COMMIT_SHA: infraSha },
            healthCheck: { command: `node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`, interval: 2, retries: 2 } });
          assert.equal(createdInfra.status, 201, createdInfra.text); infraCreated = true;
          const startedInfra = await request(`/api/infra/${infraId}/start?project=${encodeURIComponent(projectId)}`, 'POST');
          assert.equal(startedInfra.status, 200, startedInfra.text); const infra = startedInfra.json.service;
          assert.equal(infra.projectId, projectId); assert.equal(infra.status, 'running');
          const originalInfra = await ownedView(infra.containerName); assert.equal(originalInfra.State.Running, true);
          assert.deepEqual(originalInfra.HostConfig.PortBindings['8080/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(infra.hostPort) }]);
          assert.equal(originalInfra.Config.Labels['org.opencontainers.image.revision'], infraSha);
          assert.equal(originalInfra.HostConfig.RestartPolicy.Name, 'no');
          const readInfra = async () => { const res = await request(`/api/infra?project=${encodeURIComponent(projectId)}`);
            assert.equal(res.status, 200); return res.json.services.find((item: any) => item.id === infraId); };
          await until(async () => { const res = await request(infraHealthPath); assert.equal(res.status, 200);
            return res.json.health === 'healthy' ? true : undefined; }, 30_000);
          const samples: any[] = [];
          const ordinaryReads = async (phase: string) => {
            for (const endpoint of ['/api/branches', runsPath, '/healthz']) {
              const res = await request(endpoint); const row = { phase, endpoint, status: res.status, elapsedMs: res.elapsedMs };
              samples.push(row); assert.equal(res.status, 200, res.text); assert.ok(res.elapsedMs <= 5000, JSON.stringify(row));
            }
          };
          const queryGate = probeProxy!.holdInfraInspects(infra.containerName);
          const replies = [request(infraHealthPath), request(infraHealthPath)];
          void Promise.allSettled(replies);
          try {
            const held = await until(async () => Promise.race([queryGate.caught, Promise.resolve(undefined)]), 5000);
            assert.equal(held.length, 2);
            const tree = context.applicationProcessTree(), commands = new Map<number, string[]>();
            for (const row of tree) { try { commands.set(row.pid, (await fs.readFile(`/proc/${row.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)); } catch { /* Gone rows stay unknown. */ } }
            const expected = `docker inspect --format="{{.State.Health.Status}}" ${infra.containerName} 2>/dev/null || echo none`;
            const activeQueries = tree.filter(row => commands.get(row.pid)?.some(arg => arg.includes(expected))).map(row => {
              const actor = tree.find(candidate => candidate.pid === row.ppid); assert.ok(actor);
              assert.ok(commands.get(actor.pid)?.some(arg => arg.includes('observation-process.js')));
              const factory = tree.find(candidate => candidate.pid === actor.ppid); assert.ok(factory);
              assert.ok(commands.get(factory.pid)?.some(arg => arg.includes('observation-executor-process.js')));
              const factoryActors = tree.filter(candidate => candidate.ppid === factory.pid && commands.get(candidate.pid)?.some(arg => arg.includes('observation-process.js')));
              assert.equal(factoryActors.length, 2);
              return { shellPid: row.pid, actorPid: actor.pid, factoryPid: factory.pid, factoryActorCount: factoryActors.length };
            });
            assert.equal(activeQueries.length, 2); assert.equal(new Set(activeQueries.map(q => q.actorPid)).size, 2);
            assert.equal(new Set(activeQueries.map(q => q.factoryPid)).size, 1);
            report.infraObservationOccupied = { infraId, containerId: originalInfra.Id, containerName: infra.containerName, held, activeQueries };
            await ordinaryReads('both-original-observation-actors-occupied'); assert.equal(queryGate.expired(), false);
          } finally { queryGate.release(); }
          for (const res of await Promise.all(replies)) { assert.equal(res.status, 200); assert.equal(res.json.health, 'healthy'); }
          const faultGate = probeProxy!.holdInfraInspects(infra.containerName, 1, 'unavailable');
          const failedRead = request(infraHealthPath); void failedRead.catch(() => {});
          try { await until(async () => Promise.race([faultGate.caught, Promise.resolve(undefined)]), 5000); }
          finally { faultGate.release(); }
          const unknown = await failedRead; assert.equal(unknown.status, 200); assert.equal(unknown.json.health, 'none');
          assert.equal((await readInfra()).status, 'running'); assert.equal((await ownedView(originalInfra.Id)).State.Running, true);
          await ordinaryReads('controlled-proxy-503-original-query-explicit-unknown');
          const recoveredRead = await request(infraHealthPath); assert.equal(recoveredRead.status, 200); assert.equal(recoveredRead.json.health, 'healthy');
          report.infraObservationFailure = { status: unknown.status, health: unknown.json.health, faultOrigin: 'private-proxy', injectedStatus: 503, actualDaemonFailureVerified: false, statePreserved: true, recoveredHealth: recoveredRead.json.health };
          report.infraReadSamples = samples;
          const driverStoppedAt = new Date().toISOString(); await docker(['stop', '--time', '2', originalInfra.Id]);
          assert.equal((await ownedView(originalInfra.Id)).State.Running, false); assert.equal((await readInfra()).status, 'running');
          report.infraRecoveryDriverFault = { at: driverStoppedAt, containerId: originalInfra.Id, containerName: infra.containerName, controlledPrivateDriverStop: true };
          report.infraRecoveryHttpAttempts = []; report.infraRecoveryHttpAttemptOverflow = 0;
          const recoveredInfra = await until(async () => {
            const view = await ownedView(originalInfra.Id); if (!view.State.Running) return undefined;
            const events = await context.readInfraEvents(projectId, infraId);
            const completed = events.find(event => event.action === 'infra.auto-restart.completed' && event.containerName === infra.containerName
              && event.at >= driverStoppedAt && event.command?.name === 'docker start' && event.command?.exitCode === 0);
            if (!completed) return undefined;
            let response: Response;
            const attempt: any = { at: new Date().toISOString() };
            try { response = await fetch(`http://127.0.0.1:${infra.hostPort}/`, { signal: AbortSignal.timeout(3000) });
              attempt.status = response.status;
            } catch (error) {
              const cause = (error as any)?.cause?.code;
              attempt.transportError = { name: error instanceof Error ? error.name : 'unknown',
                code: typeof cause === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause) ? cause : null };
              if (report.infraRecoveryHttpAttempts.length < 64) report.infraRecoveryHttpAttempts.push(attempt);
              else report.infraRecoveryHttpAttemptOverflow++;
              // docker start completion precedes the original HTTP listener.
              // Transport readiness remains inside the unchanged 90s window.
              return undefined;
            }
            if (report.infraRecoveryHttpAttempts.length < 64) report.infraRecoveryHttpAttempts.push(attempt);
            else report.infraRecoveryHttpAttemptOverflow++;
            if (response.status !== 200) return undefined;
            const content: any = await response.json(); assert.equal(content.source, infraSha); assert.equal(content.runtime, infraSha); assert.equal(content.service, 'infra');
            assert.ok(Date.parse(view.State.StartedAt) > Date.parse(originalInfra.State.StartedAt));
            return { containerId: view.Id, startedAt: view.State.StartedAt, imageId: view.Image, completed, events, content };
          }, 90_000);
          report.infraOriginalRecovery = recoveredInfra;
          report.infrastructureRecoveryVerified = true;
          report.checks.push({ name: 'full-application-original-observation-occupancy-failure-and-infra-recovery-through-authenticated-entry', passed: true });
        } catch (error) {
          infraScenarioFailure = error; report.infraFailureDiagnostics = { at: new Date().toISOString(), originalFailure: String((error as Error).message).slice(0, 2000) };
          try { report.infraFailureDiagnostics.events = await context.readInfraEvents(projectId, infraId); }
          catch (diagnosticsError) { report.infraFailureDiagnostics.eventCaptureError = String(diagnosticsError).slice(0, 2000); }
          try { const services = await request(`/api/infra?project=${encodeURIComponent(projectId)}`);
            report.infraFailureDiagnostics.services = services.json.services.map((service: any) => ({
              id: service.id, projectId: service.projectId, status: service.status, containerName: service.containerName, hostPort: service.hostPort })); }
          catch (diagnosticsError) { report.infraFailureDiagnostics.stateCaptureError = String(diagnosticsError).slice(0, 2000); }
          throw error;
        } finally {
          if (infraCreated) { try { const removed = await requestRaw(`/api/infra/${infraId}?project=${encodeURIComponent(projectId)}`, undefined, 'manual', 'DELETE');
            const text = await removed.text(); report.fixtureInfraRemovedThroughOriginalApi = { status: removed.status }; assert.equal(removed.status, 200, text); }
            catch (cleanupError) { report.fixtureInfraCleanupFailure = String(cleanupError).slice(0, 2000); if (!infraScenarioFailure) throw cleanupError; } }
        }
        report.actualOwnedDockerApplicationPreflightVerified = true;
        context.report.actualOwnedDockerApplicationPreflightVerified = true;
        context.report.dockerExerciseReport = { file: 'docker-report.json', genericFixtureOnly: true, representativeBusinessCiVerified: false, shortReadSamples: report.readSamples.length };
        await checkpoint('original-infra-observation-and-recovery-complete');
        assert.equal(finiteCache, undefined);
        finiteCache = await prepareFiniteCoreCache(directImageId);
      } });
    report.stage = 'finite-core-image-cache';
    await checkpoint('original-application-shutdown-and-restart-complete');
    assert.ok(finiteCache);
    await finiteCache.finish();
    report.verdict = 'passed';
  } catch (error) { report.failure = { stage: report.stage, message: String((error as Error).message).slice(0, 4000) }; throw error; }
  finally {
    finiteCache?.stop();
    const cleanupErrors: string[] = [];
    if (probeProxy) {
      try { await probeProxy.settle(); report.probeRequestTimeline = probeProxy.timeline; report.proxyTraffic = probeProxy.traffic(); }
      catch (error) { cleanupErrors.push(String(error)); }
      await probeProxy.close();
      report.probeProxyRequestTimeline = probeProxy.requestTimeline; report.probeProxyTraceOverflow = probeProxy.traceOverflow();
    }
    try {
      // 该守护进程/卷由本批从空空间独占创建；原应用可产生无标签 helper。
      // 先保存身份并复核 daemon，再逐ID清理；这不是共享宿主的无标签容器删除策略。
      await processSnapshot('after-original-application-shutdown');
      await eventSnapshot('after-original-application-shutdown');
      const rows = await auditNamespace('after-original-application-shutdown-before-owned-namespace-cleanup');
      report.namespaceCleanup = [];
      for (const row of rows) {
        assert.equal(JSON.parse(await docker(['info', '--format', '{{json .}}'])).ID, info.ID);
        const view = JSON.parse(await docker(['inspect', row.id]))[0]; assert.equal(view.Id, row.id);
        assert.equal(view.Config.Labels?.['cds.acceptance.owner'] || null, row.owner);
        containers.add(row.id); await docker(['rm', '-f', row.id]);
        report.namespaceCleanup.push({ id: row.id, owner: row.owner, removed: true, namespaceOwnership: row.namespaceOwnership });
      }
      await processSnapshot('after-owned-container-removal');
      await eventSnapshot('after-owned-container-removal');
      const remaining = await auditNamespace('after-owned-container-removal-before-zero-assertion');
      report.remainingContainersBeforeOwnedDaemonRemoval = remaining;
      assert.equal(await docker(['ps', '-aq']), ''); assert.equal(remaining.length, 0); report.ownedContainersRemoved = true;
    } catch (error) {
      cleanupErrors.push(String(error));
      try { report.remainingContainersAfterCleanupFailure = await auditNamespace('after-cleanup-failure'); await eventSnapshot('after-cleanup-failure'); }
      catch (diagnosticError) { report.cleanupDiagnosticError = String(diagnosticError); }
    }
    try { for (const id of images) { const view = JSON.parse(await docker(['image', 'inspect', id]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], source.owner); await docker(['image', 'rm', '-f', id]); } report.ownedImagesRemoved = true; }
    catch (error) { cleanupErrors.push(String(error)); }
    await fs.rm(root, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    // 外层最后按归属销毁整个独占daemon卷；不对任何共享Docker做prune。
    try { report.remainingNetworksBeforeOwnedDaemonRemoval = JSON.parse(await docker(['network', 'ls', '--format', '{{json .}}']).then(s => '[' + s.split('\n').filter(Boolean).join(',') + ']')); }
    catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await fs.writeFile('/owned/output/docker-report.json', JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.ownedContainersRemoved, true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof Error ? error.message : '原应用Docker部署前提演练失败'); process.exitCode = 1; });
