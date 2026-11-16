import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { apiRequest } from '../../web/src/lib/api.js';

afterEach(() => vi.unstubAllGlobals());

it('分类编辑器通过真实 apiRequest 发送单层 JSON 对象并接收保存结果', async () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../web/src/components/ReportClassification.tsx', import.meta.url)), 'utf8');
  const ast = ts.createSourceFile('ReportClassification.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let save: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'ClassificationSummary') {
      save = node.body?.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'save');
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(save).toBeDefined();
  const classification = { categories: ['acceptance'], primarySystem: 'cds', relatedSystems: [], environments: ['production'] };
  const saved = { id: 'report-one', classification };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.method).toBe('PATCH');
    // Parse exactly once, as the reports JSON middleware does. A double-encoded
    // body yields a string here instead of the classification object.
    expect(JSON.parse(String(init?.body))).toEqual({ classification });
    return new Response(JSON.stringify({ report: saved }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const onSaved = vi.fn(), setEditing = vi.fn(), setSaving = vi.fn(), setError = vi.fn();
  const executable = ts.transpileModule(save!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const invoke = new Function('apiRequest', 'report', 'value', 'onSaved', 'setEditing', 'setSaving', 'setError', `${executable}; return save;`)(
    apiRequest, { id: saved.id }, classification, onSaved, setEditing, setSaving, setError,
  );
  await invoke();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe('/api/reports/report-one');
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(setEditing).toHaveBeenCalledWith(false);
  expect(setError.mock.calls).toEqual([['']]);
  expect(setSaving.mock.calls).toEqual([[true], [false]]);
});
