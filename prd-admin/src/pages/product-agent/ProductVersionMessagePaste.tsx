import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { parseProductVersionMessage } from '@/services/real/productAgent';
import type { VersionRegistrationMessageParseResult } from '@/services/real/productVersionRegistry';

export function ProductVersionMessagePaste({ kind, onParsed, getPlanNameEditVersion }: {
  kind: 'internal' | 'formal';
  onParsed: (result: VersionRegistrationMessageParseResult, editVersion?: number) => void;
  getPlanNameEditVersion?: () => number;
}) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const latestOnParsed = useRef(onParsed);
  latestOnParsed.current = onParsed;

  useEffect(() => {
    if (text.trim().length < 4) {
      setHint('');
      return undefined;
    }
    const currentId = ++requestId.current;
    const editVersion = getPlanNameEditVersion?.();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const response = await parseProductVersionMessage(kind, text);
        if (requestId.current !== currentId) return;
        if (!response.success) {
          setHint(response.error?.message ?? '识别失败，现有内容保持不变');
          return;
        }
        const result = response.data.result;
        if (result.matchedFields.length === 0) {
          setHint('没有识别到可回填的字段，现有内容保持不变');
          return;
        }
        latestOnParsed.current(result, editVersion);
        setHint(`已识别并回填 ${result.matchedFields.length} 项，请核对后继续。`);
      } catch {
        if (requestId.current === currentId) setHint('暂时无法识别，现有内容保持不变');
      } finally {
        if (requestId.current === currentId) setBusy(false);
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [kind, text, getPlanNameEditVersion]);

  return (
    <div className="rounded-xl border border-token-subtle bg-token-nested p-3 sm:col-span-2">
      <label htmlFor={`version-message-${kind}`} className="block text-xs font-medium text-token-secondary">粘贴企微{kind === 'internal' ? '版本立项' : '版本上线'}内容，自动回填</label>
      <textarea
        id={`version-message-${kind}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        placeholder="粘贴后自动识别；未识别的字段不会补造内容"
        className="mt-2 w-full resize-y rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none focus:border-cyan-400/60"
      />
      {(hint || busy) && <p className="mt-1 flex items-center gap-1 text-xs text-token-muted">{busy && <Loader2 size={12} className="animate-spin" />}{busy ? '正在识别企微内容…' : hint}</p>}
    </div>
  );
}
