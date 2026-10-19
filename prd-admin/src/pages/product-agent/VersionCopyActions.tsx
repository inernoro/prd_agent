import { useState } from 'react';
import { Copy } from 'lucide-react';
import { getProductVersionCopyTemplate } from '@/services/real/productAgent';

export function VersionCopyActions({ kind, id, code }: {
  kind: 'initiation' | 'release';
  id: string;
  code: string;
}) {
  const [hint, setHint] = useState('');

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setHint(`${label}已复制`);
    } catch {
      setHint('浏览器未允许复制，请选中内容手动复制');
    }
  };

  const copyTemplate = async () => {
    const response = await getProductVersionCopyTemplate(kind, id);
    if (!response.success) {
      setHint(response.error?.message ?? '生成通知失败');
      return;
    }
    await copy(response.data.text, '完整企微通知');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void copy(code, '版本号')} className="inline-flex items-center gap-1 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-xs text-token-primary hover-bg-soft"><Copy size={13} />复制编号</button>
      <button type="button" onClick={() => void copyTemplate()} className="inline-flex items-center gap-1 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-xs text-token-primary hover-bg-soft"><Copy size={13} />复制完整通知</button>
      {hint && <span role="status" className="text-xs text-token-muted">{hint}</span>}
    </div>
  );
}
