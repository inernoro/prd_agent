import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { ContentLoading } from '@/components/skeletons/ContentLoading';

export interface SourcePreview {
  generatedAt: string; scanned: number; deferred: number; cancelled: boolean; failures: number;
  scanStatus: 'complete' | 'partial';
  candidates: Array<{ identity: string; allocatedBytesEstimate: number }>;
  held: Array<{ identity: string; reason: string }>; estimateNotice: string;
}
const reasons: Record<string, string> = {
  'persistent-data': '包含持久化数据，需单独备份与迁移',
  'modified-or-unknown-files': '存在修改、未知文件或忽略文件，归属尚未证明',
  'git-query-failed': 'Git 查询失败，保留相关对象',
  'identity-changed': '目录身份已变化，保留新对象',
  'size-query-failed': '无法完整核实大小，保留相关对象',
};
export function SourcePreviewResult({ result }: { result: SourcePreview }) {
  return <div className="space-y-3 text-sm">
    <p>扫描 {result.scanned} 项，候选 {result.candidates.length} 项，保留 {result.held.length} 项，待处理 {result.deferred} 项，失败 {result.failures} 项。</p>
    {result.scanStatus === 'partial' ? <p role="status">扫描尚未完整确认，存在未确认对象或待处理项；相关对象继续保留。</p> : null}
    {result.cancelled ? <p role="status">扫描已中断，尚未检查的对象保持保护。</p> : null}
    <p className="text-xs text-muted-foreground">{result.estimateNotice}</p>
    <div className="max-h-80 overflow-auto rounded-md border border-border">
      <table className="w-full text-left text-xs">
        <thead><tr><th className="p-2">对象身份</th><th className="p-2">结果与保护原因</th></tr></thead>
        <tbody>
          {result.candidates.map(item => <tr key={item.identity} className="border-t border-border">
            <td className="break-all p-2 font-mono">{item.identity}</td>
            <td className="p-2">可回收候选，分配块估计 {item.allocatedBytesEstimate.toLocaleString()} 字节</td>
          </tr>)}
          {result.held.map(item => <tr key={item.identity} className="border-t border-border">
            <td className="break-all p-2 font-mono">{item.identity}</td>
            <td className="p-2">保留：{reasons[item.reason] || item.reason}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <p className="text-xs text-muted-foreground">生成于 {new Date(result.generatedAt).toLocaleString()}。预览不授权删除；后台执行时仍会复核当前引用、容器挂载及目录身份。</p>
  </div>;
}

export function SourceRetentionPreview() {
  const [result, setResult] = useState<SourcePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function preview() {
    controller.current?.abort();
    const ctrl = new AbortController(); controller.current = ctrl;
    setLoading(true); setError(''); setResult(null);
    try { setResult(await apiRequest<SourcePreview>('/api/janitor/deployment-sources', { signal: ctrl.signal })); }
    catch (err) { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : '查询未确认，请重试。'); }
    finally { if (controller.current === ctrl) setLoading(false); }
  }
  return <div className="space-y-3">
    <Button variant="outline" disabled={loading} onClick={() => void preview()}>预览部署源码回收</Button>
    {loading ? <ContentLoading label="正在核对引用、数据保护与对象身份" variant="table" /> : null}
    {error ? <p role="alert" className="text-sm text-destructive">查询未完成：{error}。相关对象保留，不能据此判断零占用。</p> : null}
    {result ? <SourcePreviewResult result={result} /> : null}
  </div>;
}
