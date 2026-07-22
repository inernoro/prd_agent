import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/src/routes/branches.ts'),
  'utf8',
);

describe('分支预览地址 API 契约', () => {
  it('同时下发主入口和可路由 profile 的命名入口', () => {
    expect(source).toContain('const previewHosts = Array.from(new Set(');
    expect(source).toContain('config.rootDomains?.length ? config.rootDomains');
    expect(source).toContain('const mainUrls = b.previewSlug');
    expect(source).toContain('computeBranchGatewayUrls(b, host)');
    expect(source).toContain('new Set([...mainUrls, ...namedServiceUrls])');
    expect(source).toContain('b.previewUrl = b.previewUrls[0]');
  });
});
