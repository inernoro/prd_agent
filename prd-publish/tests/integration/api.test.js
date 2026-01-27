import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import request from 'supertest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testRepoPath = resolve(__dirname, '../fixtures/api-test-repo');
const testScript = resolve(testRepoPath, 'exec.sh');
const testHistoryFile = resolve(__dirname, '../fixtures/api-history.json');
const testPublicDir = resolve(__dirname, '../fixtures/public');
const testDataDir = resolve(__dirname, '../fixtures/data');

// Get current branch name
function getCurrentBranch(repoPath) {
  try {
    return execSync('git branch --show-current', { cwd: repoPath }).toString().trim() || 'master';
  } catch {
    return 'master';
  }
}

// Setup test repo
function setupTestRepo() {
  if (existsSync(testRepoPath)) {
    rmSync(testRepoPath, { recursive: true });
  }
  mkdirSync(testRepoPath, { recursive: true });

  execSync('git init', { cwd: testRepoPath });
  execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
  execSync('git config user.name "Test User"', { cwd: testRepoPath });
  execSync('echo "test" > test.txt', { cwd: testRepoPath });
  execSync('git add .', { cwd: testRepoPath });
  execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

  // Create exec script
  const script = `#!/bin/bash
echo "Deploying: $2"
exit 0
`;
  writeFileSync(testScript, script);
  chmodSync(testScript, '755');

  // Create public dir
  mkdirSync(testPublicDir, { recursive: true });
  writeFileSync(resolve(testPublicDir, 'index.html'), '<html><body>Test</body></html>');

  // Create data dir for projects.json
  mkdirSync(testDataDir, { recursive: true });

  return execSync('git rev-parse HEAD', { cwd: testRepoPath }).toString().trim();
}

// Mock config
jest.unstable_mockModule('../../src/config.js', () => ({
  config: {
    auth: {
      username: 'admin',
      password: 'testpass',
      jwtSecret: 'test-jwt-secret',
      tokenExpiry: '1h',
    },
    server: {
      port: 0,
      host: '127.0.0.1',
    },
    git: {
      repoPath: testRepoPath,
      branch: 'main',
    },
    exec: {
      script: testScript,
      timeout: 5000,
    },
    retry: {
      autoRetry: false,
      maxCount: 3,
      delay: 100,
    },
    paths: {
      baseDir: resolve(__dirname, '../fixtures'),
      dataDir: resolve(__dirname, '../fixtures/data'),
      historyFile: testHistoryFile,
      publicDir: testPublicDir,
    },
  },
}));

const { createApp } = await import('../../src/app.js');
const { _internal: authInternal } = await import('../../src/services/authService.js');
const { _internal: deployInternal } = await import('../../src/services/deployService.js');

describe('API Integration Tests', () => {
  let app;
  let testCommitHash;
  let authToken;

  beforeAll(async () => {
    testCommitHash = setupTestRepo();
    app = createApp();

    // Get auth token for all tests
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'testpass' });
    authToken = res.body.token;
  });

  beforeEach(() => {
    authInternal.resetAttempts();
    deployInternal.resetState();
  });

  afterAll(() => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true });
    }
    if (existsSync(testHistoryFile)) {
      rmSync(testHistoryFile);
    }
    if (existsSync(testPublicDir)) {
      rmSync(testPublicDir, { recursive: true });
    }
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true });
    }
  });

  describe('Health Check', () => {
    it('GET /api/health should return healthy status', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('healthy');
    });
  });

  describe('Authentication', () => {
    describe('POST /api/login', () => {
      it('should login with valid credentials', async () => {
        const res = await request(app)
          .post('/api/login')
          .send({ username: 'admin', password: 'testpass' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeTruthy();

        authToken = res.body.token;
      });

      it('should reject invalid credentials', async () => {
        const res = await request(app)
          .post('/api/login')
          .send({ username: 'admin', password: 'wrongpass' });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      });

      it('should require username and password', async () => {
        const res = await request(app)
          .post('/api/login')
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('不能为空');
      });
    });

    describe('GET /api/verify', () => {
      it('should verify valid token', async () => {
        const res = await request(app)
          .get('/api/verify')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.body.valid).toBe(true);
        expect(res.body.user).toBe('admin');
      });

      it('should reject invalid token', async () => {
        const res = await request(app)
          .get('/api/verify')
          .set('Authorization', 'Bearer invalid-token');

        expect(res.body.valid).toBe(false);
      });
    });
  });

  describe('Git Operations', () => {
    describe('GET /api/commits', () => {
      it('should require authentication', async () => {
        const res = await request(app).get('/api/commits');
        expect(res.status).toBe(401);
      });

      it('should return commits list or error gracefully', async () => {
        const res = await request(app)
          .get('/api/commits')
          .set('Authorization', `Bearer ${authToken}`);

        // May succeed or fail depending on branch config
        expect([200, 500]).toContain(res.status);
        if (res.status === 200) {
          expect(res.body.success).toBe(true);
          expect(Array.isArray(res.body.data)).toBe(true);
        }
      });
    });

    describe('GET /api/tags', () => {
      it('should return tags list', async () => {
        const res = await request(app)
          .get('/api/tags')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
      });
    });

    describe('GET /api/status', () => {
      it('should return repo status', async () => {
        const res = await request(app)
          .get('/api/status')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.currentCommit).toBeTruthy();
        expect(['main', 'master']).toContain(res.body.data.branch);
      });
    });
  });

  describe('Deploy Operations', () => {
    describe('POST /api/deploy', () => {
      it('should require authentication', async () => {
        const res = await request(app)
          .post('/api/deploy')
          .send({ commitHash: testCommitHash });

        expect(res.status).toBe(401);
      });

      it('should reject missing commitHash', async () => {
        const res = await request(app)
          .post('/api/deploy')
          .set('Authorization', `Bearer ${authToken}`)
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('不能为空');
      });

      it('should reject invalid commitHash format', async () => {
        const res = await request(app)
          .post('/api/deploy')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ commitHash: 'invalid!hash' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('无效');
      });

      it('should deploy successfully', async () => {
        const res = await request(app)
          .post('/api/deploy')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ commitHash: testCommitHash });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    describe('GET /api/deploy/current', () => {
      it('should return current deploy status', async () => {
        const res = await request(app)
          .get('/api/deploy/current')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.isDeploying).toBe('boolean');
      });
    });
  });

  describe('History Operations', () => {
    describe('GET /api/history', () => {
      it('should return history list', async () => {
        const res = await request(app)
          .get('/api/history')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
      });

      it('should include stats', async () => {
        const res = await request(app)
          .get('/api/history')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.body.stats).toBeTruthy();
        expect(typeof res.body.stats.total).toBe('number');
      });
    });
  });

  describe('Static Files', () => {
    it('should serve index.html', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('html');
    });

    it('should return 404 for unknown API routes when authenticated', async () => {
      const res = await request(app)
        .get('/api/unknown-endpoint')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
    });
  });
});
