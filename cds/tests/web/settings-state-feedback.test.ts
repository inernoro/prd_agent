import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the real badge / JSX text expressions for the states seen in the UI.
// SOURCE also runs the same contract against the unchanged previous checkout.
const root = process.env.CDS_SETTINGS_FEEDBACK_SOURCE || process.cwd();
const load = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, 'web/src/pages/cds-settings/tabs', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const maintenance = load('MaintenanceTab.tsx'), connections = load('ConnectionsTab.tsx');
function find<T extends ts.Node>(source: ts.SourceFile, match: (node: ts.Node) => boolean): T {
  const nodes: T[] = [];
  function visit(node: ts.Node): void { if (match(node)) nodes.push(node as T); ts.forEachChild(node, visit); }
  visit(source); expect(nodes.length, 'one actual presentation expression').toBe(1); return nodes[0];
}
const color = find<ts.VariableDeclaration>(maintenance, n => ts.isVariableDeclaration(n) && n.name.getText(maintenance) === 'aheadColor').initializer!.getText(maintenance);
const badge = find<ts.JsxElement>(maintenance, n => ts.isJsxElement(n) && n.openingElement.tagName.getText(maintenance) === 'span' && n.openingElement.attributes.getText(maintenance).includes('aheadColor'));
const label = (badge.children.find(n => ts.isJsxExpression(n) && n.expression) as ts.JsxExpression).expression!.getText(maintenance);
const renderRemote = Function('data', 'remoteAheadCount', 'trackingBranch', `return { color: ${color}, label: ${label} };`) as (data: object, count: number, branch: string) => { color: string; label: string };
function remote(data: { fetchOk?: boolean; detachedHead?: boolean; remoteAheadCount?: number }) {
  return renderRemote(data, Number.isFinite(data.remoteAheadCount) ? data.remoteAheadCount! : 0, 'main');
}
const empty = find<ts.JsxElement>(connections, n => ts.isJsxElement(n) && n.openingElement.tagName.getText(connections) === 'div' && n.openingElement.attributes.getText(connections).includes('border-dashed'));
const paragraph = find<ts.JsxElement>(connections, n => ts.isJsxElement(n) && n.openingElement.tagName.getText(connections) === 'p' && n.openingElement.attributes.getText(connections).includes('max-w-3xl'));
function message(node: ts.JsxElement, confirmed: boolean, url?: string): string {
  const expression = node.children.find(n => ts.isJsxExpression(n) && n.expression) as ts.JsxExpression | undefined;
  if (!expression) return node.children.map(n => ts.isJsxText(n) ? n.text : '').join('').replace(/\s+/g, ' ').trim();
  return Function('authorizationConfirmed', 'fullyAuthorized', 'integration', `return (${expression.expression!.getText(connections)});`)(confirmed, false, { authorizationUrl: url });
}

describe('更新检查状态必须由已确认事实决定', () => {
  it.each([false, true])('fetch失败且detached=%s不显示同步成功色，保留失败语义', detachedHead => {
    const view = remote({ fetchOk: false, detachedHead, remoteAheadCount: 0 });
    expect(view.color).not.toContain('text-ok'); expect(view.label).toMatch(/失败/);
  });
  it('读取未知或远端计数未知不能归零冒充同步', () => {
    for (const data of [{ remoteAheadCount: 0 }, { fetchOk: true }]) {
      const view = remote(data); expect(view.color).not.toContain('text-ok'); expect(view.label).toMatch(/未确认/);
    }
  });
  it('确认同步才成功；落后和游离状态保留原可辨识事实', () => {
    expect(remote({ fetchOk: true, detachedHead: false, remoteAheadCount: 0 })).toMatchObject({ color: expect.stringContaining('text-ok'), label: '已与 origin/main 同步' });
    expect(remote({ fetchOk: true, remoteAheadCount: 2 }).label).toContain('领先 2');
    expect(remote({ fetchOk: true, detachedHead: true, remoteAheadCount: 0 }).label).toContain('游离提交');
  });
});
describe('空连接的下一步必须对应实际可用入口', () => {
  it('已确认URL可用时保留原跳转引导', () => { expect(message(empty, true, 'https://map.example.invalid/authorize')).toContain('前往 MAP 授权'); });
  it('无URL时不要求点击不存在的授权动作', () => {
    const text = message(empty, true); expect(text).not.toMatch(/使用上方.*前往 MAP 授权/); expect(message(paragraph, true)).toMatch(/入口.*未提供|未提供.*入口|入口不可用/); expect(text).toMatch(/管理员/);
    expect(message(paragraph, true)).not.toContain('点击后跳转');
  });
  it('授权读取未知只指向既有重读，不假报未授权', () => {
    expect(message(empty, false)).toMatch(/未确认/); expect(message(empty, false)).toMatch(/重新读取/); expect(message(empty, false)).not.toMatch(/未授权/);
  });
});
