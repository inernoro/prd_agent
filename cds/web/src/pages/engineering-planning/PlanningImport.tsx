import { useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { legacyDebtStatusLabels, type PlanningImportPreview, type PlanningImportRow } from '../../../../src/shared/engineering-planning';
import { debtLabels, planningError, planningPath, shortId, type PlanningInput } from './planning-ui';

const limit = 1_500_000;
const columns = ['title', 'sourceRef', 'sourceUrl', 'summary', 'whyDebt', 'owner', 'module', 'priority', 'discoveredAt', 'dueAt', 'decisionId', 'tags', 'criteria'];
const labels = { ready: '可导入', similar: '疑似重复', existing: '来源已存在', repeated: '批次内来源重复', invalid: '需要修正' };
const selectable = (status: keyof typeof labels) => status === 'ready' || status === 'similar';

function readCsv(text: string) {
  const rows: string[][] = [];
  let fields: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += char; i++; }
      else quoted = !quoted;
    } else if (!quoted && [',', '\n', '\r'].includes(char)) {
      fields.push(value.trim());
      value = '';
      if (char === ',') continue;
      if (fields.some(Boolean)) rows.push(fields);
      fields = [];
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else value += char;
  }
  if (quoted) throw new Error('CSV 中包含没有闭合的双引号');
  fields.push(value.trim());
  if (fields.some(Boolean)) rows.push(fields);
  const header = rows.shift() ?? [];
  if (!header.includes('title') || !header.includes('sourceRef') || header.some(key => !columns.includes(key))
    || new Set(header).size !== header.length) throw new Error('CSV 首行需有 title 和 sourceRef，请检查列名');
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`请检查 CSV 第 ${index + 2} 行的列数`);
    const { sourceRef, sourceUrl, tags, criteria, ...fields } = Object.fromEntries(header.map((key, i) => [key, row[i]]).filter(([, field]) => field));
    return { ...fields, source: { type: 'import', ref: sourceRef, ...(sourceUrl ? { url: sourceUrl } : {}) },
      ...(tags ? { tags: tags.split('|') } : {}), ...(criteria ? { criteria: criteria.split('|') } : {}) };
  });
}

function readInput(text: string): unknown[] {
  const value = text.trim();
  if (!value) throw new Error('请粘贴台账内容或选择一个文件');
  if (value.length > limit) throw new Error('文件超过 1.5 MB，请分批导入');
  let rows: unknown;
  if (value.startsWith('[') || value.startsWith('{')) {
    try { rows = value.startsWith('[') ? JSON.parse(value) : value.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error('无法解析导入内容，请检查 JSON 格式'); }
  } else rows = readCsv(value);
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('每批可导入 1 至 100 笔债务');
  return rows;
}

export function PlanningImportForm({ projectId, busy, error, onCancel, onSubmit }: {
  projectId: string; busy: boolean; error?: string; onCancel: () => void; onSubmit: (input: PlanningInput) => void;
}) {
  const [text, setText] = useState('');
  const [validation, setValidation] = useState('');
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<{ rows: unknown[]; result: PlanningImportPreview }>();
  const [selected, setSelected] = useState<number[]>([]);
  const working = busy || checking;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    if (preview) {
      if (selected.length) onSubmit({ type: 'debt.import', items: selected.map(index => preview.rows[index] as PlanningImportRow) });
      return;
    }
    let rows: unknown[];
    try { rows = readInput(text); } catch (failure) {
      setValidation(failure instanceof Error ? failure.message : '请检查台账格式');
      return;
    }
    setValidation('');
    setChecking(true);
    try {
      const result = await apiRequest<PlanningImportPreview>(`${planningPath(projectId)}/import-preview`, { method: 'POST', body: { items: rows } });
      if (result.projectId !== projectId) throw new Error('invalid project');
      setPreview({ rows, result });
      setSelected(result.items.filter(row => row.status === 'ready').map(row => row.index));
    } catch (failure) { setValidation(planningError(failure)); }
    finally { setChecking(false); }
  }
  return <form className="ep-dialog-form" onSubmit={submit}>
    <div className="ep-dialog-content">
      {preview ? <>
        <p>已检查 {preview.result.items.length} 笔，已选 {selected.length} 笔。</p>
        <ul className="ep-import-preview">{preview.result.items.map(row => <li key={row.index}>
          <label className="ep-check"><input type="checkbox" checked={selected.includes(row.index)} disabled={busy || !selectable(row.status)} onChange={event => {
            const checked = event.target.checked;
            setSelected(current => checked ? [...current, row.index] : current.filter(i => i !== row.index));
          }} />{row.title || `第 ${row.index + 1} 条`} · {labels[row.status]}</label>
          <p className="ep-caption">{row.message || row.sourceRef}{row.debtId && ` · ${shortId(row.debtId)}`}</p>
          {row.legacyStatus && row.debtStatus && <p className="ep-caption">
            原台账 {legacyDebtStatusLabels[row.legacyStatus]} · CDS {debtLabels[row.debtStatus]}
          </p>}
          {row.candidates?.map(item => <p className="ep-caption" key={item.id}>{shortId(item.id)} · {item.title}</p>)}
        </li>)}</ul>
        <button type="button" className="ep-text-button" disabled={busy} onClick={() => setPreview(undefined)}>重新编辑</button>
      </> : <>
        <p>粘贴 CSV、JSON 数组或逐行 JSON。每笔需要标题与稳定来源编号。</p>
        <label className="ep-field"><span>上传台账文件</span><input type="file" accept=".csv,.json,.jsonl,text/csv,application/json" disabled={working}
          onChange={async event => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > limit) { setValidation('文件超过 1.5 MB，请分批导入'); return; }
            try { setText(await file.text()); setValidation(''); } catch { setValidation('无法读取所选文件'); }
          }} /></label>
        <label className="ep-field"><span>导入内容</span><textarea rows={7} maxLength={limit} disabled={working} value={text}
          onChange={event => setText(event.target.value)} placeholder={'title,sourceRef,priority\n合成债务,ledger-001,mid'} /></label>
      </>}
      {(validation || error) && <p className="ep-error" role="alert">{validation || error}</p>}
    </div>
    <footer className="ep-dialog-footer"><button type="button" className="ep-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="ep-button ep-button--primary" disabled={working || (preview ? !selected.length : !text.trim())}>
        {busy ? '正在导入…' : checking ? '正在检查…' : preview ? '确认导入' : '预览导入'}
      </button>
    </footer>
  </form>;
}
