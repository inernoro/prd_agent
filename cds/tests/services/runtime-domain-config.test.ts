import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EXTERNAL_PROVIDER_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'registry.npmmirror.com',
  'www.w3.org',
]);

function hardcodedDeploymentHost(value: string): string | null {
  for (const match of value.matchAll(/https?:\/\/([^/\s"'`]+)/gi)) {
    const authority = match[1];
    if (!authority || authority.includes('${') || authority.includes('<') || authority === '...') {
      continue;
    }

    const host = authority
      .replace(/^.*@/, '')
      .split(':', 1)[0]
      .replace(/\.$/, '')
      .toLowerCase();
    if (
      EXTERNAL_PROVIDER_HOSTS.has(host)
      || !host.includes('.')
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host.endsWith('.invalid')
      || host.endsWith('.internal')
      || host.endsWith('.local')
    ) {
      continue;
    }
    return host;
  }
  return null;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (entry.isFile() && absolute.endsWith('.ts')) out.push(absolute);
  }
  return out;
}

describe('运行时域名配置', () => {
  it('生产源码字符串不携带部署域名或宿主地址', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const hits: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          const matched = hardcodedDeploymentHost(node.text);
          if (matched) {
            const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
            hits.push(`${path.relative(process.cwd(), file)}:${line}:${matched}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(hits, '部署域名必须由环境变量、连接台账或请求 Host 动态提供').toEqual([]);
  });
});
