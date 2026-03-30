import { useState } from 'react';
import { FileText, Loader2, Copy } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import type { TranscriptItem, TranscriptTemplate } from '@/services/contracts/transcriptAgent';

interface CopywritePanelProps {
  item: TranscriptItem;
  templates: TranscriptTemplate[];
}

export function CopywritePanel({ item, templates }: CopywritePanelProps) {
  const { createCopywrite, pollRun } = useTranscriptStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState('');

  const handleGenerate = async () => {
    if (!selectedTemplateId) return;
    setGenerating(true);
    setResult('');
    const run = await createCopywrite(item.id, selectedTemplateId);
    if (run) {
      const poll = async () => {
        const r = await pollRun(run.id);
        if (!r) { setGenerating(false); return; }
        if (r.status === 'completed') {
          setResult(r.result ?? '');
          setGenerating(false);
          toast.success('文案生成完成');
        } else if (r.status === 'failed') {
          setGenerating(false);
          toast.error(r.error ?? '生成失败');
        } else {
          setTimeout(poll, 2000);
        }
      };
      setTimeout(poll, 2000);
    } else {
      setGenerating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select
          className="px-3 py-2 text-sm rounded-lg bg-muted/40 border border-border outline-none focus:border-border transition-colors min-w-[140px]"
          value={selectedTemplateId}
          onChange={e => setSelectedTemplateId(e.target.value)}
        >
          <option value="">选择模板...</option>
          {templates.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <Button size="sm" onClick={handleGenerate} disabled={!selectedTemplateId || generating}>
          {generating
            ? <Loader2 className="w-4 h-4 animate-spin mr-1" />
            : <FileText className="w-4 h-4 mr-1" />}
          生成文案
        </Button>
      </div>

      {result && (
        <div className="p-4 surface-inset rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">生成结果</span>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(result);
                toast.success('已复制');
              }}
            >
              <Copy className="w-3 h-3" />
              复制
            </button>
          </div>
          <pre className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}
