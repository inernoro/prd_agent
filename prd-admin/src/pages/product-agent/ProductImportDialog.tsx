import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { importProducts, type ImportProductRow } from '@/services/real/productAgent';
import { parseProductImportFile } from './productImportParse';

const TEMPLATE_XLSX = '/templates/product-import-initial-apps.xlsx';
const TEMPLATE_CSV = '/templates/product-import-initial-apps.csv';

export function ProductImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ImportProductRow[]>([]);
  const [defaultGrade, setDefaultGrade] = useState('应用');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const readFile = async (file: File) => {
    setFileName(file.name);
    const parsed = await parseProductImportFile(file);
    setRows(parsed);
    setMessage(
      parsed.length > 0
        ? `已读取 ${parsed.length} 条（文件内已去重展示；导入时仍会跳过数据库同名产品）。`
        : '没有识别到有效数据，请检查首行列名与「产品名称」列。',
    );
  };

  const commit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    const result = await importProducts(rows, defaultGrade.trim() || undefined);
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '导入失败');
      return;
    }
    const skippedHint =
      result.data.skippedNames?.length > 0
        ? `；跳过示例：${result.data.skippedNames.slice(0, 5).join('、')}${result.data.skippedNames.length > 5 ? '…' : ''}`
        : '';
    setMessage(`导入完成：新增 ${result.data.created} 个产品，跳过 ${result.data.skipped} 个（同名已存在或文件内重复）${skippedHint}`);
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
            <div className="text-base font-semibold text-white">导入产品</div>
            <div className="mt-1 text-xs text-white/45">
              支持 CSV / Excel；写入真实数据库，导入后可像普通产品一样修改或删除。同名产品自动跳过。
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white" title="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <a
              href={TEMPLATE_XLSX}
              download
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            >
              <Download size={14} /> 下载 Excel 初始模板
            </a>
            <a
              href={TEMPLATE_CSV}
              download
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 hover:bg-white/10"
            >
              <Download size={14} /> 下载 CSV 模板
            </a>
          </div>

          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs text-white/50">默认产品类型（行内未填时使用，填类型名称如「应用」或类型 Id）</span>
            <input
              value={defaultGrade}
              onChange={(event) => setDefaultGrade(event.target.value)}
              placeholder="应用"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40"
            />
          </label>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-white/20 p-8 text-center hover:bg-white/[0.025]"
          >
            <FileSpreadsheet className="mx-auto mb-2 text-emerald-300" />
            <div className="text-sm text-white/70">选择 CSV 或 Excel 文件</div>
            <div className="mt-1 text-xs text-white/35">首行：产品名称、产品类型、产品描述、产品标识</div>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
                    <th className="px-3 py-2">产品名称</th>
                    <th className="px-3 py-2">产品类型</th>
                    <th className="px-3 py-2">产品描述</th>
                    <th className="px-3 py-2">产品标识</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 30).map((row, index) => (
                    <tr key={`${row.name}-${index}`} className="border-t border-white/5">
                      <td className="px-3 py-2 text-white/75">{row.name}</td>
                      <td className="px-3 py-2 text-white/45">{row.grade || defaultGrade || '-'}</td>
                      <td className="px-3 py-2 text-white/45">{row.description || '-'}</td>
                      <td className="px-3 py-2 text-white/45">{row.code || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 30 && <div className="px-3 py-2 text-[11px] text-white/35">仅预览前 30 条，共 {rows.length} 条</div>}
            </div>
          )}

          {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-4">
          <div className="text-xs text-white/35">仅应用管理员可导入</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white">
              取消
            </button>
            <button
              onClick={() => void commit()}
              disabled={busy || rows.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
            >
              {busy ? <MapSpinner size={14} /> : <Upload size={14} />} 确认导入 {rows.length} 条
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
