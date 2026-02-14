import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SwitcherService } from '../../src/services/switcher.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SwitcherService', () => {
  let mock: MockShellExecutor;
  let service: SwitcherService;
  let tmpDir: string;
  let confDir: string;
  let distDir: string;

  beforeEach(() => {
    mock = new MockShellExecutor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-switch-'));
    confDir = path.join(tmpDir, 'conf.d');
    distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);

    // Mock nginx commands for constructor's ensureDisconnectedConfig
    mock.addResponsePattern(/nginx -t/, () => ({ stdout: '', stderr: 'ok', exitCode: 0 }));
    mock.addResponsePattern(/nginx -s reload/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    service = new SwitcherService(mock, {
      confDir,
      distPath: distDir,
      gatewayContainerName: 'prdagent-gateway',
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe('constructor', () => {
    it('should create branches directory and _disconnected.conf', () => {
      const branchesDir = path.join(confDir, 'branches');
      expect(fs.existsSync(branchesDir)).toBe(true);
      expect(fs.existsSync(path.join(branchesDir, '_disconnected.conf'))).toBe(true);
    });

    it('should create default.conf symlink to _disconnected', () => {
      const defaultConf = path.join(confDir, 'default.conf');
      expect(fs.lstatSync(defaultConf).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(defaultConf)).toBe(path.join('branches', '_disconnected.conf'));
    });
  });

  describe('generateConfig', () => {
    it('should render nginx config with upstream', () => {
      const conf = service.generateConfig('prdagent-api-feature-a');
      expect(conf).toContain('proxy_pass http://prdagent-api-feature-a:8080');
      expect(conf).toContain('proxy_buffering off');
      expect(conf).toContain('root /usr/share/nginx/html');
    });

    it('should render disconnected config with return 502 (no upstream)', () => {
      const conf = service.generateConfig('_disconnected_upstream_');
      expect(conf).not.toContain('proxy_pass');
      expect(conf).toContain('return 502');
      expect(conf).toContain('root /usr/share/nginx/html');
    });

    it('should not contain sub_filter (badge is rendered by frontend)', () => {
      const conf = service.generateConfig('prdagent-api-feature-a');
      expect(conf).not.toContain('sub_filter');
      expect(conf).not.toContain('bt-branch-badge');
    });

    it('should generate run-mode config proxying all requests', () => {
      const conf = service.generateConfig('prdagent-api-feature-a', 'run');
      expect(conf).toContain('resolver 127.0.0.11');
      expect(conf).toContain('set $api_backend http://prdagent-api-feature-a:8080');
      expect(conf).toContain('proxy_pass $api_backend');
      expect(conf).toContain('Source-run mode');
      expect(conf).toContain('WebSocket support');
      expect(conf).not.toContain('root /usr/share/nginx/html');
    });

    it('should generate run-mode config with separate web upstream', () => {
      const conf = service.generateConfig('prdagent-api-feature-a', 'run', 'prdagent-web-feature-a');
      expect(conf).toContain('set $api_backend http://prdagent-api-feature-a:8080');
      expect(conf).toContain('set $web_backend http://prdagent-web-feature-a:8000');
      expect(conf).toContain('proxy_pass $web_backend');
    });
  });

  describe('saveBranchConfig & readBranchConfig', () => {
    it('should save and read per-branch config files', () => {
      const conf = service.generateConfig('my-upstream');
      service.saveBranchConfig('feature-a', conf);

      const read = service.readBranchConfig('feature-a');
      expect(read).toBe(conf);
    });

    it('should return null for non-existent branch config', () => {
      expect(service.readBranchConfig('nonexistent')).toBeNull();
    });
  });

  describe('removeBranchConfig', () => {
    it('should remove branch config file', () => {
      service.saveBranchConfig('feature-a', 'some config');
      expect(service.readBranchConfig('feature-a')).toBeTruthy();

      service.removeBranchConfig('feature-a');
      expect(service.readBranchConfig('feature-a')).toBeNull();
    });

    it('should not throw when removing non-existent config', () => {
      expect(() => service.removeBranchConfig('nonexistent')).not.toThrow();
    });
  });

  describe('activateBranch (symlink)', () => {
    it('should create symlink + validate + reload', async () => {
      const conf = service.generateConfig('my-upstream');
      service.saveBranchConfig('feature-a', conf);

      await service.activateBranch('feature-a');

      // Symlink should point to branches/feature-a.conf
      const defaultConf = path.join(confDir, 'default.conf');
      expect(fs.lstatSync(defaultConf).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(defaultConf)).toBe(path.join('branches', 'feature-a.conf'));

      // Should have validated and reloaded
      expect(mock.commands.some((c) => c.includes('nginx -t'))).toBe(true);
      expect(mock.commands.some((c) => c.includes('nginx -s reload'))).toBe(true);
    });

    it('should throw if branch config file missing', async () => {
      await expect(service.activateBranch('nonexistent')).rejects.toThrow('No nginx config');
    });

    it('should rollback symlink if nginx -t fails', async () => {
      const conf = service.generateConfig('my-upstream');
      service.saveBranchConfig('feature-a', conf);

      // First activate to set a known symlink target
      await service.activateBranch('feature-a');

      // Now try to activate a second branch with failing nginx -t
      service.saveBranchConfig('feature-b', 'bad config');
      // Clear patterns so the new failing pattern takes precedence
      mock.clearPatterns();
      mock.addResponsePattern(/nginx -t/, () => ({
        stdout: '',
        stderr: 'syntax error',
        exitCode: 1,
      }));

      await expect(service.activateBranch('feature-b')).rejects.toThrow('syntax');

      // Symlink should have been rolled back to feature-a
      const defaultConf = path.join(confDir, 'default.conf');
      expect(fs.readlinkSync(defaultConf)).toBe(path.join('branches', 'feature-a.conf'));
    });
  });

  describe('disconnect', () => {
    it('should symlink to _disconnected.conf', async () => {
      // First activate a branch
      service.saveBranchConfig('feature-a', service.generateConfig('my-upstream'));
      await service.activateBranch('feature-a');

      await service.disconnect();

      const defaultConf = path.join(confDir, 'default.conf');
      expect(fs.readlinkSync(defaultConf)).toBe(path.join('branches', '_disconnected.conf'));
    });
  });

  describe('getActiveBranchFromSymlink', () => {
    it('should return _disconnected initially', () => {
      expect(service.getActiveBranchFromSymlink()).toBe('_disconnected');
    });

    it('should return the activated branch id', async () => {
      service.saveBranchConfig('feature-a', service.generateConfig('my-upstream'));
      await service.activateBranch('feature-a');
      expect(service.getActiveBranchFromSymlink()).toBe('feature-a');
    });
  });

  describe('readActiveConfig', () => {
    it('should read through symlink', () => {
      const content = service.readActiveConfig();
      expect(content).toBeTruthy();
      expect(content).toContain('return 502'); // disconnected config
    });
  });

  describe('syncStaticFiles', () => {
    it('should rsync from source to dist', async () => {
      const srcDir = path.join(tmpDir, 'builds', 'feature-a');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.html'), '<html>feature-a</html>');

      mock.addResponsePattern(/rsync|cp/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.syncStaticFiles(srcDir, distDir);
      expect(mock.commands.some(c => c.includes(srcDir))).toBe(true);
    });

    it('should throw if sync fails', async () => {
      mock.addResponsePattern(/rsync|cp/, () => ({
        stdout: '',
        stderr: 'error',
        exitCode: 1,
      }));

      await expect(service.syncStaticFiles('/bad/src', distDir)).rejects.toThrow('sync');
    });
  });
});
