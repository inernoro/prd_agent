import { useState } from 'react';
import type { WritingTemplate } from '@/services/contracts/writing';
import { importWritingTemplate } from '@/services/real/writing';

export function WritingTemplateImport({ storeId, disabled, onImported }: { storeId: string; disabled: boolean; onImported: (template: WritingTemplate) => void }) {
  const [name, setName] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const headings = markdown.split(/\r?\n/).filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());
  async function read(file?: File) {
    if (!file) return;
    setError('');
    if (file.size > 200000) { setError('模版文件过大，请将内容控制在5万字以内'); return; }
    const text = await file.text();
    if (text.length > 50000) { setError('模版内容不得超过5万字'); return; }
    setName(file.name.replace(/\.[^.]+$/, '').slice(0, 80)); setMarkdown(text);
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const result = await importWritingTemplate(storeId, name, markdown);
      if (!result.success) throw new Error(result.error.message);
      onImported(result.data.template); setMarkdown(''); setName('');
    } catch (e) { setError(e instanceof Error ? e.message : '模版未能导入，请重试'); }
    finally { setBusy(false); }
  }
  return <details className="writing-template-import"><summary>导入组织模版</summary><p className="hint">上传现有Markdown模版，二级标题作为章节，标题下的文字作为写作提示。确认后供本知识库成员复用。</p>
    <input aria-label="选择组织模版文件" type="file" accept=".md,.markdown,.txt" disabled={disabled || busy} onChange={e => void read(e.target.files?.[0])} />
    {markdown && <><label className="writing-input-label">模版名称<input className="field" value={name} maxLength={80} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <ol>{headings.map((title, i) => <li key={i}>{title}</li>)}</ol><button className="btn" disabled={disabled || busy || !name.trim() || !headings.length} onClick={() => void save()}>{busy ? '正在导入模版…' : '确认导入并使用'}</button></>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
