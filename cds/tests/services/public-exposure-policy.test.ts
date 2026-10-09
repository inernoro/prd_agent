import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPublicPreviewDiscoveryEnabled } from '../../src/services/public-exposure-policy.js';

describe('测试实例公网预览发现策略', () => {
  it.each(['0', 'false', 'off', ' FALSE ', ' Off '])('显式关闭 %s 时不公开分支清单', (value) => {
    expect(isPublicPreviewDiscoveryEnabled(value)).toBe(false);
  });

  it.each(['', '1', 'true', 'on'])('未关闭 %s 时保留原有发现能力', (value) => {
    expect(isPublicPreviewDiscoveryEnabled(value)).toBe(true);
  });
});

describe('公网健康探针 nginx 策略', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../exec_cds.sh'), 'utf8');
  const emitter = script.match(/emit_server_blocks\(\) \{[\s\S]*?\n\}/)?.[0];

  function render(healthDetails = '0'): string {
    if (!emitter) throw new Error('未找到 nginx 站点生成函数');
    return execFileSync('bash', ['-c', `${emitter}\nproxy_directives() { :; }\nproxy_core() { :; }\nemit_server_blocks example.test`], {
      encoding: 'utf8',
      env: { ...process.env, NGINX_CERTS_DIR: '/nonexistent-cds-test-certs', CDS_PUBLIC_HEALTH_DETAILS: healthDetails },
    });
  }

  it('覆盖后端接受的大小写与尾斜杠路径，并强制丢弃调用方查询参数', () => {
    const config = render();
    const healthBlock = config.match(/location ~\* (\S+) \{([^}]+)\}/);
    expect(healthBlock).not.toBeNull();
    const acceptedPath = new RegExp(healthBlock![1], 'i');
    for (const url of ['/healthz', '/healthz/', '/HEALTHZ', '/HeAlThZ/']) {
      expect(acceptedPath.test(url)).toBe(true);
    }
    expect(acceptedPath.test('/healthz-extra')).toBe(false);
    expect(healthBlock![2]).toContain('rewrite ^ /healthz?lightweight=1? break;');
    // 正则 location 的 proxy_pass 不得包含 URI；rewrite 末尾问号阻止旧查询参数追加。
    expect(healthBlock![2]).toContain('proxy_pass http://cds_master;');
    expect(healthBlock![2]).not.toContain('proxy_pass http://cds_master/');
  });

  it('显式启用健康详情时保留原有后端行为', () => {
    expect(render('1')).not.toContain('rewrite ^ /healthz?lightweight=1? break;');
  });
});
