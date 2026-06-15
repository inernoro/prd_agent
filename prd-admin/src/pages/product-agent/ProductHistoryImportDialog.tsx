import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  importDefects,
  importFeatures,
  importOverviewDefects,
  importOverviewRequirements,
  importOverviewVersions,
  importRequirements,
  importVersions,
  type ImportRequirementRow,
  type ImportSimpleItemRow,
} from '@/services/real/productAgent';
import type { Product } from './types';
import { parseDefectImportFile } from './defectImportParse';
import { RequirementRtfImportDialog } from './RequirementRtfImportDialog';
import { rowHasProductRouteHint } from './requirementImportRouting';

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
  const appIndex = indexOf('应用', '所属应用', '应用名称', '应用产品', '应用/产品');
  const productIndex = indexOf('产品', '所属产品', '产品名称', '产品线', '系统产品');
  const categoryIndex = indexOf('分类', '类别', '所属分类');
  const plannedIndex = indexOf('计划发布时间', '预计结束', 'planned');
  const completedIndex = indexOf('实际发布时间', '完成时间', 'released', 'completed');
  const effectiveTitleIndex = titleIndex >= 0 ? titleIndex : 0;
  return parsed.slice(1).map((values) => {
    const rawGrade = gradeIndex >= 0 ? values[gradeIndex]?.trim() : undefined;
    const appName = appIndex >= 0 ? values[appIndex]?.trim() : undefined;
    const productName = productIndex >= 0 ? values[productIndex]?.trim() : undefined;
    const categoryName = categoryIndex >= 0 ? values[categoryIndex]?.trim() : undefined;
    const routeLabel = appName || productName || categoryName;
    return {
      title: values[effectiveTitleIndex]?.trim() ?? '',
      description: descriptionIndex >= 0 ? values[descriptionIndex]?.trim() : undefined,
      grade: rawGrade?.toLowerCase(),
      status: statusIndex >= 0 ? values[statusIndex]?.trim().toLowerCase() : undefined,
      sourceSystem: 'csv',
      externalId: externalIdIndex >= 0 ? (values[externalIdIndex]?.trim() || undefined) : undefined,
      plannedAt: plannedIndex >= 0 ? values[plannedIndex]?.trim() : undefined,
      completedAt: completedIndex >= 0 ? values[completedIndex]?.trim() : undefined,
      sourceFields: routeLabel ? { 应用: routeLabel } : undefined,
    };
  }).filter((row) => row.title);
}

export function ProductHistoryImportDialog({
  type,
  products,
  onClose,
  onImported,
  crossProductRoute = false,
}: {
  type: HistoryImportType;
  products: Product[];
  onClose: () => void;
  onImported: () => Promise<void>;
  /** 全局导入：按「应用」列路由，未匹配则跳过 */
  crossProductRoute?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isCrossProduct = crossProductRoute && (type === 'requirement' || type === 'defect' || type === 'version');
  const needsProductPicker = !isCrossProduct;
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
    if (rows.length === 0) return;
    if (needsProductPicker && !productId) return;
    const baseRows = rows as ImportRequirementRow[];
    const rowsToImport = baseRows;
    if (isCrossProduct && rowsToImport.every((row) => !rowHasProductRouteHint(row))) {
      setMessage('无法路由：请确认文件的「分类」或「应用/产品」列填的是系统已有产品名，或在标题前加【产品名】。');
      return;
    }
    setBusy(true);
    const result = type === 'requirement'
      ? (crossProductRoute
        ? await importOverviewRequirements(rowsToImport)
        : await importRequirements(productId, rowsToImport))
      : type === 'feature'
        ? await importFeatures(productId, rows)
        : type === 'defect'
          ? (crossProductRoute
            ? await importOverviewDefects(rowsToImport)
            : await importDefects(productId, rows))
          : crossProductRoute
            ? await importOverviewVersions(rowsToImport)
            : await importVersions(productId, rows);
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '导入失败');
      return;
    }
    const data = result.data;
    const created = data.created ?? 0;
    const updated = data.updated ?? 0;
    const skipped = 'skipped' in data ? (data.skipped ?? 0) : 0;
    if (created + updated === 0) {
      setMessage(
        skipped > 0
          ? `未写入任何${TYPE_LABEL[type]}：${skipped} 条因「分类/应用/产品」未匹配系统产品被跳过。请确认这些列填的是系统已有产品名，或在标题前加【产品名】。`
          : `未写入任何${TYPE_LABEL[type]}，请检查文件内容。`,
      );
      return;
    }
    setMessage(
      `导入完成：新增 ${created} 条，更新 ${updated} 条${
        skipped > 0 ? `，${skipped} 条「应用」未匹配已跳过` : ''
      }。`,
    );
    await onImported();
    onClose();
  };

  if (rtfFiles.length > 0 && (productId || crossProductRoute)) {
    return (
      <RequirementRtfImportDialog
        productId={productId || products[0]?.id || ''}
        crossProductRoute={crossProductRoute}
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
            <div className="mt-1 text-xs text-white/45">
              {isCrossProduct
                ? '按文件「分类」或「应用/产品」列自动匹配系统产品；未匹配行跳过，无需手动选归属产品。'
                : '可重复导入；有外部 ID 时更新原记录，无 ID 时系统自动分配纯数字编号。'}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white" title="关闭"><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {needsProductPicker && (
            <label className="mb-4 block">
              <span className="mb-1.5 block text-xs text-white/50">归属产品</span>
              <select value={productId} onChange={(event) => setProductId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none">
                {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </select>
            </label>
          )}
          <button onClick={() => inputRef.current?.click()} className="w-full rounded-xl border border-dashed border-white/20 p-8 text-center hover:bg-white/[0.025]">
            <FileSpreadsheet className="mx-auto mb-2 text-emerald-300" />
            <div className="text-sm text-white/70">选择 {type === 'requirement' ? 'CSV 或 RTF' : type === 'defect' ? 'TAPD 导出 CSV / Excel / RTF' : 'CSV'} 文件</div>
            <div className="mt-1 text-xs text-white/35">{type === 'defect' ? 'TAPD「优先级」→ 系统「严重程度」；其它列无值则留空' : '需求 RTF 支持多选；CSV 首行需为字段名'}</div>
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
                <thead className="bg-[#1a1c22] text-white/45"><tr><th className="px-3 py-2">标题</th><th className="px-3 py-2">ID</th>{isCrossProduct && <th className="px-3 py-2">归属产品</th>}<th className="px-3 py-2">{type === 'defect' ? '严重程度' : '等级'}</th><th className="px-3 py-2">状态</th>{type === 'defect' && <th className="px-3 py-2">处理人</th>}</tr></thead>
                <tbody>{rows.slice(0, 30).map((row, index) => {
                  const routeLabel = row.sourceFields?.['应用']
                    || row.sourceFields?.['所属应用']
                    || row.sourceFields?.['应用名称']
                    || row.sourceFields?.['所属产品']
                    || row.sourceFields?.['产品']
                    || row.sourceFields?.['产品名称']
                    || row.sourceFields?.['产品线']
                    || row.sourceFields?.['系统产品']
                    || row.sourceFields?.['分类']
                    || row.sourceFields?.['类别']
                    || row.sourceFields?.['所属分类']
                    || (row.title?.match(/^【([^】]+)】/)?.[1] ?? '');
                  return (
                    <tr key={`${row.externalId ?? row.title}-${index}`} className="border-t border-white/5">
                      <td className="px-3 py-2 text-white/75">{row.title}</td>
                      <td className="px-3 py-2 text-white/45">{row.externalId || '-'}</td>
                      {isCrossProduct && <td className="px-3 py-2 text-white/45">{routeLabel || '—'}</td>}
                      <td className="px-3 py-2 text-white/45">{type === 'defect' ? (row.severity ? `${row.severity}（TAPD优先级:${row.tapdSeverityRaw || '—'}）` : (row.tapdSeverityRaw || '—')) : (row.grade || '-')}</td>
                      <td className="px-3 py-2 text-white/45">{row.status || '-'}</td>
                      {type === 'defect' && <td className="px-3 py-2 text-white/45">{row.handlerNames?.join('、') || '-'}</td>}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-4">
          <div className="text-xs text-white/35">
            {isCrossProduct
              ? '按文件「分类/应用/产品」列自动路由到系统产品'
              : selectedProduct ? `将写入：${selectedProduct.name}` : '请选择产品'}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white">取消</button>
            <button onClick={() => void commit()} disabled={busy || (needsProductPicker && !productId) || rows.length === 0} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40">
              {busy ? <MapSpinner size={14} /> : <Upload size={14} />} 确认导入 {rows.length} 条
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
