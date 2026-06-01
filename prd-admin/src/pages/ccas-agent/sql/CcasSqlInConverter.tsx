import { useCallback, useEffect, useState } from 'react';
import { Copy, Eraser, Wand2, HelpCircle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { toInClause } from './sqlHelpers';

const SAMPLE_PLACEHOLDER = `每行一个值，例如：
ABC123
DEF456
O'Brien`;

/**
 * IN 转化子 tab。
 *
 * 把每行一条的数据转为 SQL `IN (...)` 子句可用的括号列表。
 * 用户体验对照源参考站点：onInput 实时转换 + 显式按钮兜底 + 一键复制。
 */
export function CcasSqlInConverter() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [validRows, setValidRows] = useState(0);
  const [itemCount, setItemCount] = useState(0);

  const runConvert = useCallback((raw: string) => {
    const r = toInClause(raw);
    setOutput(r.output);
    setValidRows(r.validRows);
    setItemCount(r.itemCount);
  }, []);

  useEffect(() => {
    runConvert(input);
  }, [input, runConvert]);

  const handleClear = useCallback(() => {
    setInput('');
    setOutput('');
    setValidRows(0);
    setItemCount(0);
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
        <span>
          将每行一条的数据转为 <code className="px-1 py-0.5 rounded bg-black/35 text-amber-200">IN</code> 子句可用的括号列表，空行自动忽略，单引号会按 SQL 标准转义为两个单引号。
        </span>
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-white/65">
            <span>输入原始数据（每行一个值）</span>
            <span className="text-white/40">有效行：{validRows}</span>
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
            <span>
              SQL IN 格式：<code className="px-1 py-0.5 rounded bg-black/35 text-amber-200">WHERE col IN (...)</code>
            </span>
            <span className="text-white/40">项目数：{itemCount}</span>
          </div>
          <textarea
            value={output}
            readOnly
            spellCheck={false}
            rows={14}
            placeholder="转换结果会显示在这里"
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-emerald-200/90 font-mono leading-relaxed placeholder:text-white/30 focus:outline-none focus:border-amber-300/40 transition"
            style={{ resize: 'vertical', minHeight: 280 }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => runConvert(input)}>
          <Wand2 className="w-3.5 h-3.5" />
          转换
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
