// @vitest-environment jsdom
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

// 执行真实提示回调，验证后到的成功消息不会抹掉输入丢弃警告。
const path = resolve(dirname(fileURLToPath(import.meta.url)), '../AdvancedVisualAgentTab.tsx');
const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'showUploadToast' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('未找到真实上传提示回调');
const script = ts.transpileModule(`const show = ${callback.getText(source)}; show;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
afterEach(() => vi.useRealTimers());

it('超限警告保留六秒，期间普通上传成功不能覆盖；结束后恢复普通提示', () => {
  vi.useFakeTimers();
  const setUploadToast = vi.fn();
  const show = vm.runInNewContext(script, {
    window, setUploadToast, uploadToastTimerRef: { current: null }, uploadToastPriorityRef: { current: 'info' },
  }) as (text: string, priority?: 'info' | 'warning') => void;
  show('其余图片未上传，请分批添加', 'warning');
  show('上传成功：2 张');
  expect(setUploadToast).toHaveBeenLastCalledWith({ text: '其余图片未上传，请分批添加' });
  vi.advanceTimersByTime(5999);
  expect(setUploadToast).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(setUploadToast).toHaveBeenLastCalledWith(null);
  show('上传成功：20 张');
  expect(setUploadToast).toHaveBeenLastCalledWith({ text: '上传成功：20 张' });
});
