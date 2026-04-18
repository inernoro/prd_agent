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
import { createGithubWebhookRouter } from '../../src/routes/github-webhook.js';

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
): Promise<{ status: number; body: any }> {
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
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
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
      after: 'deadbeef',
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
    expect(deployCalls).toEqual([{ branchId: 'sample-feature-x', commitSha: 'deadbeef' }]);
  });

  it('silently ignores push to unlinked repo (no deploy)', async () => {
    server = startServer();
    const payload = {
      ref: 'refs/heads/main',
      after: 'abc',
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
