/** Read-only UI loading inventory: JSX positions, not template names or grep hits. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../web/src');
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const progressOwners = new Map([
  ['DbProbePanel', '真实数据库探测阶段与已等待秒数'],
  ['EnvSetupDialog', '数据库初始化信号扫描阶段'],
  ['ServiceLogsPanel', '已有日志旁的后台读取状态'],
  ['WebEntryConfigDialog', '逐个地址验证状态图标'],
  ['BranchSearchDropdown', '已有远程结果旁的刷新状态'],
  ['PreviewActionSplitButton', '预览按钮的动作反馈'],
  ['ApiProbe', '诊断接口实测状态'],
]);
const loadingCondition = text => {
  const positive = text.replace(/(['"])(.*?)\1/g, (match, quote, value) => ['loading', 'checking'].includes(value) ? match : '""').replace(/!\s*\w*[Ll]oading\w*/g, 'false');
  return /===\s*['"](?:loading|checking)['"]/.test(positive) || /\b(?:\w*[Ll]oading|\w*[Ff]etching|discovering)\b/.test(positive);
};
function ownerOf(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text;
  }
  return '<module>';
}
function hasJsx(node) {
  let yes = false;
  const visit = n => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) yes = true; ts.forEachChild(n, visit); };
  visit(node); return yes;
}
export function auditLoadingCoverage(root = sourceRoot) {
  const waits = [], sharedSites = [];
  for (const file of files(root).filter(f => f.endsWith('.tsx'))) {
    const text = fs.readFileSync(file, 'utf8'), sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const position = n => ({ file: path.relative(root, file), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, owner: ownerOf(n, sf) });
    const visit = n => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const name = n.tagName.getText(sf);
        if (['ContentLoading', 'LoadingBlock'].includes(name)) {
          const attr = n.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(sf) === 'label');
          sharedSites.push({ ...position(n), component: name, label: attr?.initializer?.getText(sf) ?? '加载中' });
        }
      }
      let condition, body;
      if (ts.isConditionalExpression(n)) { condition = n.condition; body = n.whenTrue; }
      if (ts.isIfStatement(n)) { condition = n.expression; body = n.thenStatement; }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { condition = n.left; body = n.right; }
      if (condition && body && loadingCondition(condition.getText(sf)) && hasJsx(body)) {
        const record = { ...position(n), condition: condition.getText(sf), category: 'uncovered', reason: '' };
        let control = false;
        for (let p = n.parent; p; p = p.parent) {
          if (ts.isJsxAttribute(p) || ts.isJsxElement(p) && /^(?:Button|button|select|option)$/.test(p.openingElement.tagName.getText(sf))) control = true;
        }
        const markup = body.getText(sf);
        if (control) { record.category = 'action'; record.reason = '按钮或原生控件的等待反馈'; }
        else if (/<(?:ContentLoading|LoadingBlock|\w*Skeleton|ConsoleRouteFallback)\b|cds-loading-skeleton-/.test(markup)) { record.category = 'skeleton'; }
        else if (progressOwners.has(record.owner) && (
          record.owner === 'DbProbePanel' && record.condition === "state.status === 'loading'" ||
          record.owner === 'EnvSetupDialog' && record.condition.includes('databaseInit.status') ||
          record.owner === 'ServiceLogsPanel' && record.condition.includes('isCurrent') ||
          record.owner === 'WebEntryConfigDialog' && record.condition.includes('c.state') ||
          record.owner === 'BranchSearchDropdown' && record.condition === 'remoteLoading' ||
          record.owner === 'PreviewActionSplitButton' || record.owner === 'ApiProbe'
        )) { record.category = 'progress'; record.reason = progressOwners.get(record.owner); }
        else if (/^<Loader2\b/.test(markup) && record.owner === 'CommandPalette') { record.category = 'progress'; record.reason = '搜索输入框刷新指示，结果区域另有骨架'; }
        waits.push(record);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sharedSites, waits, uncovered: waits.filter(x => x.category === 'uncovered'), counts: { shared: sharedSites.length, contentLoading: sharedSites.filter(x => x.component === 'ContentLoading').length, loadingBlock: sharedSites.filter(x => x.component === 'LoadingBlock').length, conditionalViews: waits.length } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditLoadingCoverage();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (process.argv.includes('--check') && result.uncovered.length) process.exitCode = 1;
}
