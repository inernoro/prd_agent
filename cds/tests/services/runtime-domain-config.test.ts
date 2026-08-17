import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const OWNED_DEPLOYMENT_SUFFIXES = ['miduo.org', 'ebcone.net', 'ebcone.cn'];

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
    if (OWNED_DEPLOYMENT_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return host;
  }
  return null;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (entry.isFile() && /\.tsx?$/.test(absolute) && !/\.(?:test|spec)\.tsx?$/.test(absolute)
      && !absolute.includes(`${path.sep}tests${path.sep}`)
      && !absolute.includes(`${path.sep}__tests__${path.sep}`)) out.push(absolute);
  }
  return out;
}

describe('运行时域名配置', () => {
  it('生产源码字符串不携带部署域名或宿主地址', () => {
    const srcRoots = [
      path.resolve(process.cwd(), 'src'),
      path.resolve(process.cwd(), 'web/src'),
      path.resolve(process.cwd(), '../prd-admin/src'),
      path.resolve(process.cwd(), '../prd-desktop/src'),
      path.resolve(process.cwd(), '../llmgw/web/src'),
    ];
    const hits: string[] = [];
    for (const file of srcRoots.flatMap(sourceFiles)) {
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
