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

function shippedTextFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...shippedTextFiles(absolute));
    else if (entry.isFile() && /\.(?:ts|tsx|js|html|md|sh|service)$/.test(entry.name)) out.push(absolute);
  }
  return out;
}

describe('运行时域名配置', () => {
  it('正式网关回跳地址由 compose 显式注入', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), '../docker-compose.yml'), 'utf8');
    expect(source).toContain('LLMGW_MAP_HOME_URL=${LLMGW_MAP_HOME_URL:?');
  });

  it('CDS 技能回源不把本实例公网地址当上游', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/server.ts'), 'utf8');
    expect(source).toContain("cdsUpstream: process.env.CDS_UPSTREAM?.trim() || ''");
    expect(source).not.toContain("process.env.CDS_UPSTREAM?.trim() || process.env.CDS_PUBLIC_BASE_URL");
  });

  it('Agent 上手助手从运行时配置读取 MAP 地址', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'web/src/components/AgentStarterTab.tsx'), 'utf8');
    expect(source).toContain("apiRequest<{ prdAgentBaseUrl?: string }>('/api/config')");
    expect(source).toContain('setPrdAgentOrigin(runtimeOrigin)');
  });

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

  it('交付源码、脚本、文档和演示不携带真实部署域名', () => {
    const roots = [
      path.resolve(process.cwd(), 'src'),
      path.resolve(process.cwd(), 'web/src'),
      path.resolve(process.cwd(), 'web/demo'),
      path.resolve(process.cwd(), 'web-legacy'),
      path.resolve(process.cwd(), 'scripts'),
      path.resolve(process.cwd(), 'systemd'),
      path.resolve(process.cwd(), 'tutorial'),
      path.resolve(process.cwd(), 'README.md'),
      path.resolve(process.cwd(), 'exec_cds.sh'),
    ];
    const hits: string[] = [];
    const ownedDomain = new RegExp(`(?:${OWNED_DEPLOYMENT_SUFFIXES.map((value) => value.replace('.', '\\.')).join('|')})`, 'i');
    for (const file of roots.flatMap(shippedTextFiles)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (ownedDomain.test(lines[i])) hits.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
      }
    }
    expect(hits, '真实部署域名不得出现在交付内容中；示例统一使用 example.com').toEqual([]);
  });
});
