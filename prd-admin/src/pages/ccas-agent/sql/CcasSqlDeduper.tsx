import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Eraser, Filter, HelpCircle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { dedupLines, type DedupOptions } from './sqlHelpers';

const SAMPLE_PLACEHOLDER = `每行一个值，例如：
aaa
bbb
aaa
ccc`;

interface OptionChipProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function OptionChip({ label, checked, onChange }: OptionChipProps) {
  return (
    <label
      className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none px-2.5 py-1 rounded-md border transition"
      style={{
        borderColor: checked ? 'rgba(252, 211, 77, 0.45)' : 'rgba(255,255,255,0.10)',
        background: checked ? 'rgba(252, 211, 77, 0.10)' : 'rgba(255,255,255,0.03)',
        color: checked ? 'rgba(252, 211, 77, 0.95)' : 'rgba(255,255,255,0.70)',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-amber-400"
      />
      {label}
    </label>
  );
}

/**
 * 去重子 tab。
 *
 * 按行去重，空行忽略；可选保持顺序 / 忽略大小写 / 去掉首尾空格。
 * 选项变更或输入变更都会实时重算，按"去重"按钮做兜底操作。
 */
export function CcasSqlDeduper() {
  const [input, setInput] = useState('');
  const [keepOrder, setKeepOrder] = useState(true);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [trimSpaces, setTrimSpaces] = useState(true);

  const options: DedupOptions = useMemo(
    () => ({ keepOrder, ignoreCase, trimSpaces }),
    [keepOrder, ignoreCase, trimSpaces]
  );

  const [output, setOutput] = useState('');
  const [rawRows, setRawRows] = useState(0);
  const [uniqueRows, setUniqueRows] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [removedCount, setRemovedCount] = useState(0);

  const runDedup = useCallback(
    (raw: string, opts: DedupOptions, silent: boolean) => {
      const r = dedupLines(raw, opts);
      setOutput(r.output);
      setRawRows(r.rawRows);
      setUniqueRows(r.uniqueRows);
      setDuplicateCount(r.duplicateCount);
      setRemovedCount(r.removedCount);
      if (!silent) {
        if (r.uniqueRows === 0) {
          toast.warning('没有有效数据');
        } else {
          toast.success(`去重完成，移除 ${r.removedCount} 条重复数据`);
        }
      }
    },
    []
  );

  useEffect(() => {
    runDedup(input, options, true);
  }, [input, options, runDedup]);

  const handleClear = useCallback(() => {
    setInput('');
    setOutput('');
    setRawRows(0);
    setUniqueRows(0);
    setDuplicateCount(0);
    setRemovedCount(0);
    toast.info('已清空');
  }, []);

  const handleCopy = useCallback(async () => {
    if (!output) {
      toast.warning('没有可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(output);
      toast.success('复制成功');
    } catch {
      toast.error('复制失败', '请手动选中文本复制');
    }
  }, [output]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-white/55 leading-relaxed flex items-start gap-1.5">
        <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300/70" />
        <span>按行去重，空行自动忽略。下面三个开关分别控制：是否保留原始顺序、是否忽略大小写、比较前是否去掉首尾空白。</span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <OptionChip label="保持原始顺序" checked={keepOrder} onChange={setKeepOrder} />
        <OptionChip label="忽略大小写" checked={ignoreCase} onChange={setIgnoreCase} />
        <OptionChip label="去除首尾空格" checked={trimSpaces} onChange={setTrimSpaces} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-white/65">
            <span>输入原始数据</span>
            <span className="flex items-center gap-3 text-white/40">
              <span>原始：{rawRows}</span>
              {duplicateCount > 0 && (
                <span className="text-red-300/85">重复：{duplicateCount}</span>
              )}
            </span>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            rows={14}
            placeholder={SAMPLE_PLACEHOLDER}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/90 font-mono leading-relaxed placeholder:text-white/30 focus:outline-none focus:border-amber-300/40 transition"
            style={{ resize: 'vertical', minHeight: 280 }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-white/65">
            <span>去重后输出</span>
            <span className="flex items-center gap-3 text-white/40">
              <span className="text-emerald-300/85">去重后：{uniqueRows}</span>
              {removedCount > 0 && <span>移除：{removedCount}</span>}
            </span>
          </div>
          <textarea
            value={output}
            readOnly
            spellCheck={false}
            rows={14}
            placeholder="去重结果会显示在这里"
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-emerald-200/90 font-mono leading-relaxed placeholder:text-white/30 focus:outline-none focus:border-amber-300/40 transition"
            style={{ resize: 'vertical', minHeight: 280 }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => runDedup(input, options, false)}>
          <Filter className="w-3.5 h-3.5" />
          去重
        </Button>
        <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!output}>
          <Copy className="w-3.5 h-3.5" />
          复制结果
        </Button>
        <Button variant="ghost" size="sm" onClick={handleClear} disabled={!input && !output}>
          <Eraser className="w-3.5 h-3.5" />
          清空
        </Button>
      </div>
    </div>
  );
}
