import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ServiceState } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Preview auto-wake scoping guard.
 *
 * The only thing that may be auto-revived on a passive preview visit is a
 * branch the SCHEDULER cooled (idle, lastStopSource='scheduler', containers
 * preserved). Errored / user-stopped / no-service branches, and non-navigation
 * (asset/bot) requests, must NEVER trigger a revive — otherwise broken or
 * intentionally-stopped branches would redeploy on every stray hit.
 */
describe('ProxyService preview auto-wake scoping', () => {
  let stateService: StateService;
  let proxy: ProxyService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-autowake-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    proxy = new ProxyService(stateService);
    // Upstream resolver present so an eligible HOT branch would proxy normally.
    proxy.setResolveUpstream(() => 'http://127.0.0.1:39999');
  });

  function svc(profileId: string, status: ServiceState['status']): ServiceState {
    return { profileId, containerName: `c-${profileId}`, hostPort: 30000, status } as ServiceState;
  }

  function addBranch(over: Partial<BranchEntry>): BranchEntry {
    const id = StateService.slugify('feat/cooled');
    const entry = {
      id,
      branch: 'feat/cooled',
      projectId: 'default',
      status: 'idle',
      services: { web: svc('web', 'stopped') },
      lastStopSource: 'scheduler',
      ...over,
    } as BranchEntry;
    stateService.addBranch(entry);
    return entry;
  }

  function makeReq(url = '/', headers: Record<string, string> = {}): http.IncomingMessage {
    return { method: 'GET', url, headers: { 'x-branch': 'feat/cooled', accept: 'text/html', ...headers } } as unknown as http.IncomingMessage;
  }

  function makeRes(): http.ServerResponse {
    return {
      writeHead: vi.fn(),
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as http.ServerResponse;
  }

  it('fires revive for a scheduler-cooled idle branch on navigation', async () => {
    addBranch({});
    const revive = vi.fn(async () => {});
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(revive).toHaveBeenCalledTimes(1);
    expect(revive).toHaveBeenCalledWith(StateService.slugify('feat/cooled'));
  });

  it('does NOT fire for a user-stopped idle branch', async () => {
    addBranch({ lastStopSource: 'user' });
    const revive = vi.fn(async () => {});
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(revive).not.toHaveBeenCalled();
  });

  it('does NOT fire for an errored branch', async () => {
    addBranch({ status: 'error', lastStopSource: 'crash' });
    const revive = vi.fn(async () => {});
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(revive).not.toHaveBeenCalled();
  });

  it('does NOT fire for a cooled branch with no built services', async () => {
    addBranch({ services: {} });
    const revive = vi.fn(async () => {});
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(revive).not.toHaveBeenCalled();
  });

  it('does NOT fire for a static asset request (only top-level navigation)', async () => {
    addBranch({});
    const revive = vi.fn(async () => {});
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq('/assets/app.js'), makeRes());

    expect(revive).not.toHaveBeenCalled();
  });

  it('dedupes concurrent navigation hits into a single revive', async () => {
    addBranch({});
    // Never-resolving promise keeps the slug "in flight" across both calls.
    const revive = vi.fn(() => new Promise<void>(() => {}));
    proxy.setOnReviveCooled(revive);

    await proxy.handleRequest(makeReq(), makeRes());
    await proxy.handleRequest(makeReq(), makeRes());

    expect(revive).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no revive callback is wired (auto-wake disabled)', async () => {
    addBranch({});
    // No setOnReviveCooled — should fall through to the diagnostic page path
    // without throwing.
    await proxy.handleRequest(makeReq(), makeRes());
    expect(true).toBe(true);
  });
});
