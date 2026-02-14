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
  let nginxConf: string;
  let distDir: string;

  beforeEach(() => {
    mock = new MockShellExecutor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-switch-'));
    nginxConf = path.join(tmpDir, 'nginx.conf');
    distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);

    service = new SwitcherService(mock, {
      nginxConfPath: nginxConf,
      distPath: distDir,
      gatewayContainerName: 'prdagent-gateway',
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
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
      // Run mode uses nginx variables for deferred DNS resolution (Docker resolver)
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

  describe('backup & rollbackConfig', () => {
    it('should backup current config', () => {
      fs.writeFileSync(nginxConf, 'original config');
      service.backup();
      expect(fs.existsSync(nginxConf + '.rollback')).toBe(true);
      expect(fs.readFileSync(nginxConf + '.rollback', 'utf-8')).toBe('original config');
    });

    it('should restore config from backup', () => {
      fs.writeFileSync(nginxConf, 'original config');
      service.backup();
      fs.writeFileSync(nginxConf, 'new config');

      mock.addResponsePattern(/nginx -t/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/nginx -s reload/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      service.rollbackConfig();
      expect(fs.readFileSync(nginxConf, 'utf-8')).toBe('original config');
    });
  });

  describe('applyConfig', () => {
    it('should write config + validate + reload', async () => {
      mock.addResponsePattern(/nginx -t/, () => ({
        stdout: '',
        stderr: 'syntax is ok\ntest is successful',
        exitCode: 0,
      }));
      mock.addResponsePattern(/nginx -s reload/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const conf = service.generateConfig('my-upstream');
      await service.applyConfig(conf);

      expect(fs.readFileSync(nginxConf, 'utf-8')).toBe(conf);
      expect(mock.commands.some((c) => c.includes('nginx -t'))).toBe(true);
      expect(mock.commands.some((c) => c.includes('nginx -s reload'))).toBe(true);
    });

    it('should throw and rollback if nginx -t fails', async () => {
      fs.writeFileSync(nginxConf, 'good config');
      service.backup();

      mock.addResponsePattern(/nginx -t/, () => ({
        stdout: '',
        stderr: 'syntax error',
        exitCode: 1,
      }));

      const badConf = 'bad { config';
      await expect(service.applyConfig(badConf)).rejects.toThrow('syntax');
      // Should have restored the backup
      expect(fs.readFileSync(nginxConf, 'utf-8')).toBe('good config');
    });

    it('should throw if reload fails', async () => {
      mock.addResponsePattern(/nginx -t/, () => ({ stdout: '', stderr: 'ok', exitCode: 0 }));
      mock.addResponsePattern(/nginx -s reload/, () => ({
        stdout: '',
        stderr: 'reload failed',
        exitCode: 1,
      }));

      await expect(service.applyConfig('some config')).rejects.toThrow('reload');
    });
  });

  describe('syncStaticFiles', () => {
    it('should rsync from source to dist', async () => {
      const srcDir = path.join(tmpDir, 'builds', 'feature-a');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.html'), '<html>feature-a</html>');

      mock.addResponsePattern(/rsync|cp/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.syncStaticFiles(srcDir, distDir);
      expect(mock.commands[0]).toContain(srcDir);
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
