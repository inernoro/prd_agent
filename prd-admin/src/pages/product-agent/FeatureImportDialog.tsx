import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { importFeatureTree, type ImportFeatureTreeRow } from '@/services/real/productAgent';
import { parseFeatureTreeImportFile } from './featureImportParse';

const TEMPLATE_CSV = '/templates/feature-import-structure.csv';

export function FeatureImportDialog({
  productId,
  onClose,
  onImported,
}: {
  productId: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ImportFeatureTreeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [message, setMessage] = useState('');

  const applyParsed = (name: string, parsed: ImportFeatureTreeRow[]) => {
    setFileName(name);
    setRows(parsed);
    if (parsed.length > 0) {
      const hint = `已读取 ${parsed.length} 条目录节点，确认后写入功能树。`;
      setMessage(hint);
      toast.success(hint);
      return;
    }
    const emptyHint = '没有识别到有效数据。请检查首行列名包含「目录路径」，且从第 2 行起填写路径（用 / 分隔层级）。';
    setMessage(emptyHint);
    toast.warning(emptyHint);
  };

  const readFile = async (file: File) => {
    setParsing(true);
    setMessage('');
    try {
      applyParsed(file.name, await parseFeatureTreeImportFile(file));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '文件解析失败';
      setMessage(errMsg);
      toast.error(errMsg);
      setRows([]);
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const commit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    const result = await importFeatureTree(productId, rows);
    setBusy(false);
    if (!result.success) {
      const errMsg = result.error?.message ?? '导入失败';
      setMessage(errMsg);
      toast.error(errMsg);
      return;
    }
    const doneMsg = `导入完成：新增 ${result.data.created} 条，更新 ${result.data.updated} 条`;
    setMessage(doneMsg);
    toast.success(doneMsg);
    await onImported();
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-4xl flex-col rounded-xl border border-white/15 bg-[#111319] shadow-2xl"
        style={{ maxHeight: 'min(820px, calc(100vh - 32px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-base font-semibold text-white">导入功能目录结构</div>
            <div className="mt-1 text-xs text-white/45">
              用「目录路径」列描述无限层级树（如 营销活动/优惠券/满减）。缺省上级会自动补齐；同路径重复导入会更新。
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white" title="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <a
              href={TEMPLATE_CSV}
              download
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            >
              <Download size={14} /> 下载 CSV 模板
            </a>
            <label
              htmlFor={inputId}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
            >
              {parsing ? <MapSpinner size={14} /> : <Upload size={14} />} 选择 CSV / Excel
            </label>
            <input
              id={inputId}
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
              }}
            />
          </div>

          <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-white/55">
            <div className="mb-1 font-medium text-white/70">Excel 列结构（首行表头）</div>
            <div className="font-mono text-[11px] text-cyan-200/80">
              目录路径, 功能名称, 等级, 功能类型, 所属模块, 描述, 外部ID, 关键规则, 验收标准
            </div>
            <ul className="mt-2 list-disc pl-4 space-y-0.5">
              <li>目录路径：必填，层级用 <code className="text-white/60">/</code> 分隔，层级深度不限</li>
              <li>功能名称：可空，默认取路径最后一段</li>
              <li>功能类型：basic / core / value_added（或中文：基础功能、核心功能、增值功能）</li>
            </ul>
          </div>

          {fileName && (
            <div className="mb-2 flex items-center gap-2 text-xs text-white/45">
              <FileSpreadsheet size={14} /> {fileName} · {rows.length} 条
            </div>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-white/[0.04] text-white/45">
                  <tr>
                    <th className="px-3 py-2 font-medium">目录路径</th>
                    <th className="px-3 py-2 font-medium">功能名称</th>
                    <th className="px-3 py-2 font-medium">等级</th>
                    <th className="px-3 py-2 font-medium">模块</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 30).map((row, i) => (
                    <tr key={`${row.path}-${i}`} className="border-t border-white/5">
                      <td className="px-3 py-2 font-mono text-cyan-200/75">{row.path}</td>
                      <td className="px-3 py-2 text-white/75">{row.title ?? '—'}</td>
                      <td className="px-3 py-2 text-white/55">{row.grade ?? '—'}</td>
                      <td className="px-3 py-2 text-white/55">{row.moduleName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 30 && <div className="px-3 py-2 text-[11px] text-white/35">仅预览前 30 条，共 {rows.length} 条</div>}
            </div>
          )}

          {message && <div className="mt-3 text-xs text-white/50">{message}</div>}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button onClick={onClose} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:bg-white/5">取消</button>
          <button
            onClick={() => void commit()}
            disabled={busy || rows.length === 0}
            className="rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40"
          >
            {busy ? '导入中…' : `确认导入 ${rows.length} 条`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
