import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  importDefects,
  importFeatures,
  importRequirements,
  importVersions,
  type ImportSimpleItemRow,
} from '@/services/real/productAgent';
import type { Product } from './types';
import { parseDefectImportFile } from './defectImportParse';
import { RequirementRtfImportDialog } from './RequirementRtfImportDialog';

export type HistoryImportType = 'requirement' | 'feature' | 'defect' | 'version';

const TYPE_LABEL: Record<HistoryImportType, string> = {
  requirement: '需求',
  feature: '功能',
  defect: '缺陷',
  version: '版本',
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseProductHistoryCsv(text: string, _options?: { entityType?: HistoryImportType }): ImportSimpleItemRow[] {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return [];
  const headers = parsed[0].map((value) => value.trim().toLowerCase());
  const indexOf = (...names: string[]) => headers.findIndex((header) => names.some((name) => header.includes(name)));
  const titleIndex = indexOf('标题', '名称', '版本名', 'title', 'name');
  const descriptionIndex = indexOf('描述', '内容', 'description', 'desc');
  const gradeIndex = indexOf('分级', '等级', '级别', 'grade');
  const statusIndex = indexOf('状态', '生命周期', 'status', 'lifecycle');
  const externalIdIndex = indexOf('需求 id', '外部id', '外部 id', 'externalid', 'external id', '编号', 'id', '缺陷id');
  const plannedIndex = indexOf('计划发布时间', '预计结束', 'planned');
  const completedIndex = indexOf('实际发布时间', '完成时间', 'released', 'completed');
  const effectiveTitleIndex = titleIndex >= 0 ? titleIndex : 0;
  return parsed.slice(1).map((values) => {
    const rawGrade = gradeIndex >= 0 ? values[gradeIndex]?.trim() : undefined;
    return {
      title: values[effectiveTitleIndex]?.trim() ?? '',
      description: descriptionIndex >= 0 ? values[descriptionIndex]?.trim() : undefined,
      grade: rawGrade?.toLowerCase(),
      status: statusIndex >= 0 ? values[statusIndex]?.trim().toLowerCase() : undefined,
      sourceSystem: 'csv',
      externalId: externalIdIndex >= 0 ? values[externalIdIndex]?.trim() : undefined,
      plannedAt: plannedIndex >= 0 ? values[plannedIndex]?.trim() : undefined,
      completedAt: completedIndex >= 0 ? values[completedIndex]?.trim() : undefined,
    };
  }).filter((row) => row.title);
}

export function ProductHistoryImportDialog({
  type,
  products,
  onClose,
  onImported,
}: {
  type: HistoryImportType;
  products: Product[];
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [rows, setRows] = useState<ImportSimpleItemRow[]>([]);
  const [rtfFiles, setRtfFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selectedProduct = useMemo(() => products.find((product) => product.id === productId), [productId, products]);

  const readFiles = async (files: File[]) => {
    setFileNames(files.map((file) => file.name));
    const rtf = files.filter((file) => file.name.toLowerCase().endsWith('.rtf'));
    if (rtf.length > 0) {
      if (type === 'requirement') {
        setRtfFiles(rtf);
        return;
      }
      if (type === 'defect') {
        try {
          const parsedRows: ImportSimpleItemRow[] = [];
          for (const file of rtf) {
            parsedRows.push(...await parseDefectImportFile(file));
          }
          setRows(parsedRows);
          setMessage(parsedRows.length > 0 ? `已读取 ${parsedRows.length} 条缺陷（RTF），确认后写入。` : '没有识别到有效缺陷，请检查文件。');
        } catch (err) {
          setMessage(err instanceof Error ? err.message : 'RTF 解析失败');
        }
        return;
      }
      setMessage('RTF 仅支持需求与缺陷导入，功能与版本请使用 CSV。');
      return;
    }
    const spreadsheet = files.find((file) => {
      const n = file.name.toLowerCase();
      return n.endsWith('.csv') || n.endsWith('.xlsx') || n.endsWith('.xls');
    });
    if (!spreadsheet) {
      setMessage(type === 'defect' ? '请选择 TAPD 导出的 CSV 或 Excel（.xlsx）。' : '请选择 CSV 文件。需求还可选择 RTF 导出文件。');
      return;
    }
    try {
      const parsedRows = type === 'defect'
        ? await parseDefectImportFile(spreadsheet)
        : parseProductHistoryCsv(await spreadsheet.text(), { entityType: type });
      setRows(parsedRows);
      setMessage(parsedRows.length > 0 ? `已读取 ${parsedRows.length} 条，确认后写入。` : '没有识别到有效数据，请检查标题列。');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '解析失败');
    }
  };

  const commit = async () => {
    if (!productId || rows.length === 0) return;
    setBusy(true);
    const result = type === 'requirement'
      ? await importRequirements(productId, rows)
      : type === 'feature'
        ? await importFeatures(productId, rows)
        : type === 'defect'
          ? await importDefects(productId, rows)
          : await importVersions(productId, rows);
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '导入失败');
      return;
    }
    setMessage(`导入完成：新增 ${result.data.created} 条，更新 ${result.data.updated} 条。`);
    await onImported();
  };

  if (rtfFiles.length > 0 && productId) {
    return (
      <RequirementRtfImportDialog
        productId={productId}
        files={rtfFiles}
        onClose={onClose}
        onImported={onImported}
      />
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
      <div className="flex w-full max-w-4xl flex-col rounded-xl border border-white/15 bg-[#111319] shadow-2xl" style={{ maxHeight: 'min(820px, calc(100vh - 32px))' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-base font-semibold text-white">导入历史{TYPE_LABEL[type]}</div>
            <div className="mt-1 text-xs text-white/45">可重复导入；相同 TAPD ID 会更新原记录，ID 与 TAPD 保持一致。</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white" title="关闭"><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs text-white/50">归属产品</span>
            <select value={productId} onChange={(event) => setProductId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none">
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </label>
          <button onClick={() => inputRef.current?.click()} className="w-full rounded-xl border border-dashed border-white/20 p-8 text-center hover:bg-white/[0.025]">
            <FileSpreadsheet className="mx-auto mb-2 text-emerald-300" />
            <div className="text-sm text-white/70">选择 {type === 'requirement' ? 'CSV 或 RTF' : type === 'defect' ? 'TAPD 导出 CSV / Excel / RTF' : 'CSV'} 文件</div>
            <div className="mt-1 text-xs text-white/35">{type === 'defect' ? '需含「严重程度」列；RTF 导出会解析「处理人」并匹配系统用户' : '需求 RTF 支持多选；CSV 首行需为字段名'}</div>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple={type === 'requirement'}
            accept={type === 'requirement' ? '.csv,.rtf,text/csv,application/rtf' : type === 'defect' ? '.csv,.xlsx,.xls,.rtf,text/csv,application/rtf' : '.csv,text/csv'}
            className="hidden"
            onChange={(event) => void readFiles(Array.from(event.target.files ?? []))}
          />
          {fileNames.length > 0 && <div className="mt-3 text-xs text-white/40">{fileNames.join('、')}</div>}
          {rows.length > 0 && (
            <div className="mt-4 overflow-auto rounded-lg border border-white/10">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-[#1a1c22] text-white/45"><tr><th className="px-3 py-2">标题</th><th className="px-3 py-2">ID</th><th className="px-3 py-2">{type === 'defect' ? '严重程度' : '等级'}</th><th className="px-3 py-2">状态</th>{type === 'defect' && <th className="px-3 py-2">处理人</th>}</tr></thead>
                <tbody>{rows.slice(0, 30).map((row, index) => <tr key={`${row.externalId ?? row.title}-${index}`} className="border-t border-white/5"><td className="px-3 py-2 text-white/75">{row.title}</td><td className="px-3 py-2 text-white/45">{row.externalId || '-'}</td><td className="px-3 py-2 text-white/45">{type === 'defect' ? (row.severity ? `${row.severity}（TAPD:${row.tapdSeverityRaw || '—'}）` : (row.tapdSeverityRaw || '—')) : (row.grade || '-')}</td><td className="px-3 py-2 text-white/45">{row.status || '-'}</td>{type === 'defect' && <td className="px-3 py-2 text-white/45">{row.handlerNames?.join('、') || '-'}</td>}</tr>)}</tbody>
              </table>
            </div>
          )}
          {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-4">
          <div className="text-xs text-white/35">{selectedProduct ? `将写入：${selectedProduct.name}` : '请选择产品'}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white">取消</button>
            <button onClick={() => void commit()} disabled={busy || !productId || rows.length === 0} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40">
              {busy ? <MapSpinner size={14} /> : <Upload size={14} />} 确认导入 {rows.length} 条
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
