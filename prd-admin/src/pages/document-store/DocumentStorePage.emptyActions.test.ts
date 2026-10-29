import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_STORE_EMPTY_ACTIONS } from './DocumentStorePage';
import { advanceDocumentUploadProgress, beginDocumentUploadProgress } from './documentUploadProgress';

describe('document store empty actions', () => {
  it('keeps all onboarding cards actionable', () => {
    expect(DOCUMENT_STORE_EMPTY_ACTIONS.map(action => action.key)).toEqual([
      'create',
      'upload',
      'emergence',
    ]);
    expect(DOCUMENT_STORE_EMPTY_ACTIONS.every(action => action.title && action.desc)).toBe(true);
  });
});

type SelectedFile = Pick<File, 'name' | 'size'>;

// 执行实际组件的原handleFiles回调，不复制过滤算法，也不请求任何业务端点。
function actualUploadHandler() {
  const source = readFileSync(new URL('./DocumentStorePage.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('DocumentStorePage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.ArrowFunction | undefined;
  let limitExpression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'MAX_UPLOAD_BYTES') limitExpression = node.initializer;
      if (node.name.text === 'handleFiles' && node.initializer && ts.isCallExpression(node.initializer)) {
        const candidate = node.initializer.arguments[0];
        if (candidate && ts.isArrowFunction(candidate)) callback = candidate;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!callback || !limitExpression) throw new Error('实际上传回调或20MB上限缺失');
  const maxBytes = new Function(`return (${limitExpression.getText(tree)});`)() as number;
  expect(maxBytes).toBe(20 * 1024 * 1024);
  const upload = vi.fn(async (_storeId: string, file: SelectedFile) => ({ success: true, data: { entry: { id: file.name } } }));
  const toast = { error: vi.fn(), success: vi.fn() };
  const setUploading = vi.fn();
  const setUploadProgress = vi.fn();
  const setEntries = vi.fn();
  const setSelectedEntryId = vi.fn();
  const bindings = {
    MAX_UPLOAD_BYTES: maxBytes, storeId: 'stsmk-offline-store', toast,
    uploadDocumentFileWithProgress: upload, setUploading, setUploadProgress, setEntries, setSelectedEntryId,
    beginDocumentUploadProgress, advanceDocumentUploadProgress,
  };
  const compiled = ts.transpileModule(`const handler = ${callback.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const handleFiles = new Function(...Object.keys(bindings), `${compiled}\nreturn handler;`)(...Object.values(bindings)) as (files: SelectedFile[]) => Promise<void>;
  return { handleFiles, upload, toast, setUploading, setUploadProgress, setEntries, setSelectedEntryId };
}

describe('document store actual upload callback preflight', () => {
  it('rejects zero bytes before uploading with a readable recovery action and no ghost entry', async () => {
    const h = actualUploadHandler();
    await h.handleFiles([{ name: '空文件.txt', size: 0 }]);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('文件为空: 空文件.txt', '请选择非空文件后重新上传');
    expect(h.setUploading).not.toHaveBeenCalled();
    expect(h.setEntries).not.toHaveBeenCalled();
    expect(h.setSelectedEntryId).not.toHaveBeenCalled();
  });

  it('filters only zero bytes and oversized files, keeping valid order and the inclusive 20MB boundary', async () => {
    const h = actualUploadHandler();
    const boundary = { name: '边界.txt', size: 20 * 1024 * 1024 };
    const oneByte = { name: '一个字节.txt', size: 1 };
    await h.handleFiles([{ name: '空.txt', size: 0 }, boundary, { name: '超限.txt', size: boundary.size + 1 }, oneByte]);
    expect(h.upload.mock.calls.map(call => call[1])).toEqual([boundary, oneByte]);
    expect(h.toast.error).toHaveBeenCalledWith('文件为空: 空.txt', '请选择非空文件后重新上传');
    expect(h.toast.error).toHaveBeenCalledWith('文件过大: 超限.txt', '单文件上限 20MB（该文件 20.0MB）');
    expect(h.setUploadProgress.mock.calls[0][0]).toMatchObject({ name: boundary.name, index: 1, total: 2 });
    expect(h.setUploadProgress.mock.calls[1][0]).toMatchObject({ name: oneByte.name, index: 2, total: 2 });
    expect(h.toast.success).toHaveBeenCalledWith('上传完成', '2 个文件已存储');
    expect(h.setSelectedEntryId).toHaveBeenCalledWith(boundary.name);
  });

  it('preserves the oversized-only rejection without entering upload state', async () => {
    const h = actualUploadHandler();
    await h.handleFiles([{ name: '大文件.txt', size: 21 * 1024 * 1024 }]);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('文件过大: 大文件.txt', '单文件上限 20MB（该文件 21.0MB）');
    expect(h.setUploading).not.toHaveBeenCalled();
  });

  it('leaves valid uploads and an empty picker unchanged', async () => {
    const h = actualUploadHandler();
    await h.handleFiles([]);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
    await h.handleFiles([{ name: '正文.txt', size: 12 }]);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.setUploading.mock.calls).toEqual([[true], [false]]);
    expect(h.setEntries).toHaveBeenCalledTimes(1);
  });
});
