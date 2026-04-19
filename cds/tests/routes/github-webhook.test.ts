/**
 * Integration tests for the /api/github/webhook receiver.
 *
 * Mounts the webhook router on a minimal Express app with the same
 * raw-body middleware production uses, then fires synthetic webhook
 * payloads through it. HTTP plumbing only — the dispatcher's own
 * behaviour is covered by github-webhook-dispatcher.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig } from '../../src/types.js';
import {
  createGithubWebhookRouter,
  __resetWebhookDedupForTests,
} from '../../src/routes/github-webhook.js';

class MockShell implements IShellExecutor {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

class MockWorktree extends WorktreeService {
  override async create() { /* no-op */ }
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: raw, headers: res.headers });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildConfig(overrides?: Partial<CdsConfig>): CdsConfig {
  return {
    repoRoot: '/tmp/repo',
    worktreeBase: '/tmp/wt',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'x'.repeat(32), issuer: 'cds' },
    mode: 'standalone',
    executorPort: 9901,
    githubApp: {
      appId: '12345',
      privateKey: 'unused-for-webhook',
      webhookSecret: 'whsec-test',
    },
    ...overrides,
  };
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('GitHub webhook route', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;
  let deployCalls: Array<{ branchId: string; commitSha: string }>;

  function startServer(configOverrides?: Partial<CdsConfig>): http.Server {
    const app = express();
    // Same verify hook production uses — stashes rawBody on the request.
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }));
    const shell = new MockShell();
    const worktree = new MockWorktree(shell);
    deployCalls = [];
    const config = buildConfig(configOverrides);
    app.use('/api', createGithubWebhookRouter({
      stateService,
      worktreeService: worktree,
      shell,
      config,
      githubApp: null, // listInstallations-type endpoints return 503 in these tests
      dispatchDeploy: async (branchId, commitSha) => {
        deployCalls.push({ branchId, commitSha });
      },
    }));
    return app.listen(0);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-webhook-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    __resetWebhookDedupForTests();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 503 when GitHub App is not configured', async () => {
    server = startServer({ githubApp: undefined });
    const res = await request(server, 'POST', '/api/github/webhook', '{}', {
      'X-GitHub-Event': 'ping',
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });

  it('rejects requests without a signature header', async () => {
    server = startServer();
    const res = await request(server, 'POST', '/api/github/webhook', '{}', {
      'X-GitHub-Event': 'ping',
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid signature', async () => {
    server = startServer();
    const body = '{"zen":"wrong"}';
    const res = await request(server, 'POST', '/api/github/webhook', body, {
      'X-GitHub-Event': 'ping',
      'X-Hub-Signature-256': sign('different-secret', body),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('accepts a valid ping', async () => {
    server = startServer();
    const body = '{"zen":"Non-blocking is better than blocking."}';
    const res = await request(server, 'POST', '/api/github/webhook', body, {
      'X-GitHub-Event': 'ping',
      'X-Hub-Signature-256': sign('whsec-test', body),
      'X-GitHub-Delivery': 'delivery-abc',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ignored-ping');
    expect(res.body.deployDispatched).toBe(false);
    expect(res.body.delivery).toBe('delivery-abc');
  });

  it('dispatches a deploy when push matches a linked project', async () => {
    stateService.addProject({
      id: 'pX',
      slug: 'sample',
      name: 'Sample',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo',
      githubInstallationId: 42,
    });
    server = startServer();
    const payload = {
      ref: 'refs/heads/feature-x',
      after: 'deadbeef01234567890abcdef1234567890abcde',
      repository: { id: 1, full_name: 'octocat/repo' },
      installation: { id: 42 },
    };
    const body = JSON.stringify(payload);
    const res = await request(server, 'POST', '/api/github/webhook', body, {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': sign('whsec-test', body),
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('branch-created');
    expect(res.body.branchId).toBe('sample-feature-x');
    expect(res.body.deployDispatched).toBe(true);

    // Deploy dispatcher runs async; allow it a beat.
    await new Promise((r) => setTimeout(r, 20));
    expect(deployCalls).toEqual([{ branchId: 'sample-feature-x', commitSha: 'deadbeef01234567890abcdef1234567890abcde' }]);
  });

  it('silently ignores push to unlinked repo (no deploy)', async () => {
    server = startServer();
    const payload = {
      ref: 'refs/heads/main',
      after: 'abc1234567890abcdef1234567890abcdef12345',
      repository: { full_name: 'some-other/repo' },
    };
    const body = JSON.stringify(payload);
    const res = await request(server, 'POST', '/api/github/webhook', body, {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': sign('whsec-test', body),
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ignored-no-project');
    expect(res.body.deployDispatched).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(deployCalls).toHaveLength(0);
  });

  it('ack-and-skip (200 + suppress-activity header) for unsubscribed noise events', async () => {
    server = startServer();
    // check_suite / workflow_run / pull_request_review / status are
    // common culprits when the GitHub App is subscribed to "all events"
    // — none actionable by CDS, should bypass the dispatcher entirely.
    for (const noiseEvent of ['check_suite', 'workflow_run', 'pull_request_review', 'status', 'star']) {
      const body = JSON.stringify({ repository: { full_name: 'octocat/repo' } });
      const res = await request(server, 'POST', '/api/github/webhook', body, {
        'X-GitHub-Event': noiseEvent,
        'X-Hub-Signature-256': sign('whsec-test', body),
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.action).toBe('ignored-unsubscribed');
      expect(res.body.event).toBe(noiseEvent);
      expect(res.headers['x-cds-suppress-activity']).toBe('1');
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(deployCalls).toHaveLength(0);
  });

  it('returns 200 (ok:false) — NOT 500 — when the dispatcher throws', async () => {
    // Wire a worktree mock that explodes so handlePush throws synchronously
    // inside the dispatcher. Before the fix, the route surfaced this as a
    // 500, which made GitHub retry the delivery — a real user hit this and
    // the retry storm rebuilt the app in a loop.
    stateService.addProject({
      id: 'pY',
      slug: 'boom',
      name: 'Boom',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo',
      githubInstallationId: 42,
    });

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }));
    const shell = new MockShell();
    class BoomWorktree extends WorktreeService {
      override async create(): Promise<void> { throw new Error('simulated git worktree failure'); }
    }
    const worktree = new BoomWorktree(shell);
    deployCalls = [];
    app.use('/api', createGithubWebhookRouter({
      stateService,
      worktreeService: worktree,
      shell,
      config: buildConfig(),
      githubApp: null,
      dispatchDeploy: async (b, s) => { deployCalls.push({ branchId: b, commitSha: s }); },
    }));
    server = app.listen(0);

    const payload = {
      ref: 'refs/heads/unknown-branch',
      after: 'feedface01234567890abcdef1234567890abcde',
      repository: { full_name: 'octocat/repo' },
      installation: { id: 42 },
    };
    const body = JSON.stringify(payload);
    const res = await request(server, 'POST', '/api/github/webhook', body, {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': sign('whsec-test', body),
    });
    // Critical: 200 (not 500) so GitHub doesn't retry the delivery.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('dispatch_error');
    expect(res.body.event).toBe('push');
    expect(res.body.message).toContain('simulated git worktree failure');
    // No deploy should have been dispatched.
    await new Promise((r) => setTimeout(r, 20));
    expect(deployCalls).toHaveLength(0);
  });

  it('dedups repeated (branchId, sha) deploy dispatches within the window', async () => {
    stateService.addProject({
      id: 'pZ',
      slug: 'sample',
      name: 'Sample',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo',
      githubInstallationId: 42,
    });
    server = startServer();

    const payload = {
      ref: 'refs/heads/feature-dedup',
      after: 'cafef00d1234567890abcdef1234567890abcdef',
      repository: { full_name: 'octocat/repo' },
      installation: { id: 42 },
    };
    const body = JSON.stringify(payload);
    const headers = {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': sign('whsec-test', body),
    };

    // First delivery — dispatches.
    const res1 = await request(server, 'POST', '/api/github/webhook', body, headers);
    expect(res1.status).toBe(200);
    expect(res1.body.deployDispatched).toBe(true);
    expect(res1.body.deployDedupSkipped).toBeUndefined();

    // Immediate second delivery (GitHub retry or check_run.rerequested)
    // — same branch + same SHA — should be deduped, no extra dispatch.
    const res2 = await request(server, 'POST', '/api/github/webhook', body, headers);
    expect(res2.status).toBe(200);
    expect(res2.body.deployDispatched).toBe(false);
    expect(res2.body.deployDedupSkipped).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    // Only the first delivery reached the deploy dispatcher.
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].commitSha).toBe(payload.after);
  });
});

describe('POST /api/projects/:id/github/link', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;

  function startServer(): http.Server {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }));
    const shell = new MockShell();
    const worktree = new MockWorktree(shell);
    app.use('/api', createGithubWebhookRouter({
      stateService,
      worktreeService: worktree,
      shell,
      config: buildConfig(),
      githubApp: null,
      dispatchDeploy: async () => {},
    }));
    return app.listen(0);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-link-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    stateService.addProject({
      id: 'p1',
      slug: 'sample',
      name: 'Sample',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('validates installationId + repoFullName', async () => {
    server = startServer();
    const res = await request(server, 'POST', '/api/projects/p1/github/link',
      JSON.stringify({ installationId: 42 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation');
  });

  it('rejects malformed repoFullName', async () => {
    server = startServer();
    const res = await request(server, 'POST', '/api/projects/p1/github/link',
      JSON.stringify({ installationId: 42, repoFullName: 'not-a-repo' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('repoFullName');
  });

  it('links a project', async () => {
    server = startServer();
    const res = await request(server, 'POST', '/api/projects/p1/github/link',
      JSON.stringify({ installationId: 42, repoFullName: 'octocat/repo' }),
    );
    expect(res.status).toBe(200);
    const project = stateService.getProject('p1')!;
    expect(project.githubRepoFullName).toBe('octocat/repo');
    expect(project.githubInstallationId).toBe(42);
    expect(project.githubAutoDeploy).toBe(true);
  });

  it('rejects a duplicate link', async () => {
    stateService.addProject({
      id: 'p2',
      slug: 'other',
      name: 'Other',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo',
      githubInstallationId: 42,
    });
    server = startServer();
    const res = await request(server, 'POST', '/api/projects/p1/github/link',
      JSON.stringify({ installationId: 42, repoFullName: 'octocat/repo' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_linked');
  });

  it('DELETE clears the link', async () => {
    stateService.updateProject('p1', {
      githubInstallationId: 42,
      githubRepoFullName: 'octocat/repo',
      githubAutoDeploy: true,
    });
    server = startServer();
    const res = await request(server, 'DELETE', '/api/projects/p1/github/link', '');
    expect(res.status).toBe(200);
    const project = stateService.getProject('p1')!;
    expect(project.githubRepoFullName).toBeUndefined();
    expect(project.githubInstallationId).toBeUndefined();
  });
});
