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
