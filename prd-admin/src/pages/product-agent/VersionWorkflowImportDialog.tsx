import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { importVersionWorkflow } from '@/services/real/productAgent';
import type { Product } from './types';
import {
  parseVersionWorkflowImportFile,
  type VersionWorkflowImportKind,
  type VersionWorkflowImportRow,
} from './versionWorkflowImportParse';

const KIND_LABEL: Record<VersionWorkflowImportKind, string> = {
  release: '正式版本',
  initiation: '内部版本',
};

export function VersionWorkflowImportDialog({
  kind,
  products,
  defaultProductId,
  fixedProductId,
  onClose,
  onImported,
}: {
  kind: VersionWorkflowImportKind;
  products: Product[];
  defaultProductId?: string;
  fixedProductId?: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [productId, setProductId] = useState(fixedProductId ?? defaultProductId ?? products[0]?.id ?? '');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<VersionWorkflowImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId),
    [productId, products],
  );

  const importableCount = useMemo(
    () => (kind === 'release' ? rows.filter((row) => row.code).length : rows.length),
    [kind, rows],
  );

  const readFile = async (file: File) => {
    setFileName(file.name);
    try {
      const parsedRows = await parseVersionWorkflowImportFile(file, kind);
      setRows(parsedRows);
      if (parsedRows.length === 0) {
        setMessage('没有识别到有效数据，请检查表头是否含方案名称或版本号列。');
        return;
      }
      const missingCode = kind === 'release'
        ? parsedRows.filter((row) => !row.code).length
        : 0;
      const importable = kind === 'release'
        ? parsedRows.filter((row) => row.code).length
        : parsedRows.length;
      setMessage(
        missingCode > 0
          ? `已读取 ${parsedRows.length} 条，可导入 ${importable} 条（${missingCode} 条无 V 号或「-」将跳过）。`
          : `已读取 ${parsedRows.length} 条，确认后写入。`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '解析失败');
    }
  };

  const commit = async () => {
    const targetProductId = fixedProductId ?? productId;
    if (!targetProductId || rows.length === 0) return;
    setBusy(true);
    const payloadRows = rows
      .filter((row) => (kind === 'release' ? Boolean(row.code) : true))
      .map(({ sourceRow: _sourceRow, ...row }) => row);
    const result = await importVersionWorkflow(targetProductId, { kind, rows: payloadRows });
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '导入失败');
      return;
    }
    const errorCount = result.data.errors?.length ?? 0;
    setMessage(
      errorCount > 0
        ? `导入完成：新增 ${result.data.created} 条，${errorCount} 条校验失败。`
        : `导入完成：新增 ${result.data.created} 条。`,
    );
    await onImported();
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
      <div
        className="flex w-full max-w-4xl flex-col rounded-xl border border-white/15 bg-[#111319] shadow-2xl"
        style={{ maxHeight: 'min(820px, calc(100vh - 32px))' }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-base font-semibold text-white">导入历史{KIND_LABEL[kind]}</div>
            <div className="mt-1 text-xs text-white/45">
              支持 Excel（.xlsx / .xls）和 CSV；表头兼容历史导出列名，带 T/V 号的记录原样写入。
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white" title="关闭">
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
          {!fixedProductId && (
            <label className="mb-4 block">
              <span className="mb-1.5 block text-xs text-white/50">归属产品</span>
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
              >
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-white/20 p-8 text-center hover:bg-white/[0.025]"
          >
            <FileSpreadsheet className="mx-auto mb-2 text-emerald-300" />
            <div className="text-sm text-white/70">选择 Excel 或 CSV 文件</div>
            <div className="mt-1 text-xs text-white/35">
              {kind === 'release'
                ? '需含「正式版本号 / V 号」与「产品立项方案名称」列'
                : '需含「T 立项号 / 立项号」或「产品立项方案名称」列'}
            </div>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          {fileName && <div className="mt-3 text-xs text-white/40">{fileName}</div>}
          {rows.length > 0 && (
            <div className="mt-4 overflow-auto rounded-lg border border-white/10">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-[#1a1c22] text-white/45">
                  <tr>
                    <th className="px-3 py-2">行号</th>
                    <th className="px-3 py-2">{kind === 'release' ? 'V 号' : 'T 号'}</th>
                    {kind === 'release' && <th className="px-3 py-2">T 号</th>}
                    <th className="px-3 py-2">方案名称</th>
                    <th className="px-3 py-2">版本类别</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 30).map((row, index) => (
                    <tr key={`${row.code ?? row.planName}-${index}`} className="border-t border-white/5">
                      <td className="px-3 py-2 text-white/35">{row.sourceRow}</td>
                      <td className="px-3 py-2 font-mono text-white/75">{row.code || '-'}</td>
                      {kind === 'release' && <td className="px-3 py-2 font-mono text-white/55">{row.tCode || '-'}</td>}
                      <td className="px-3 py-2 text-white/75">{row.planName}</td>
                      <td className="px-3 py-2 text-white/45">{row.versionType || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-4">
          <div className="text-xs text-white/35">
            {fixedProductId || selectedProduct ? `将写入：${selectedProduct?.name ?? '当前产品'}` : '请选择产品'}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white">
              取消
            </button>
            <button
              onClick={() => void commit()}
              disabled={busy || !(fixedProductId ?? productId) || importableCount === 0}
              className="flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
            >
              {busy ? <MapSpinner size={14} /> : <Upload size={14} />}
              确认导入 {importableCount} 条
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
