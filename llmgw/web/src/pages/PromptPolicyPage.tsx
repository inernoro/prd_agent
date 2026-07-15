import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { rollbackPromptPolicy, getPromptPolicy, previewPromptPolicy, savePromptPolicy } from '@/lib/api';
import type { PromptPolicyData, PromptPolicyDraft, PromptPolicyPreview } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

const VARIABLES = ['tenantId', 'teamId', 'appCallerCode', 'requestType', 'sourceSystem'];
const emptyDraft: PromptPolicyDraft = { expectedVersion: 0, systemPromptPrefix: '', systemPromptSuffix: '', enabled: true, allowedVariables: [], maxChars: 8000 };

export function PromptPolicyPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<PromptPolicyData | null>(null);
  const [draft, setDraft] = useState<PromptPolicyDraft>(emptyDraft);
  const [sample, setSample] = useState('你是一个可靠的助手。');
  const [preview, setPreview] = useState<PromptPolicyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await getPromptPolicy(id);
    if (!res.success) { setError(res.error?.message || '加载失败'); return; }
    setData(res.data);
    const current = res.data.current;
    setDraft(current ? {
      expectedVersion: current.version,
      systemPromptPrefix: current.systemPromptPrefix,
      systemPromptSuffix: current.systemPromptSuffix,
      enabled: current.enabled,
      allowedVariables: current.allowedVariables,
      maxChars: current.maxChars,
    } : emptyDraft);
  };
  useEffect(() => { void load(); }, [id]);

  const runPreview = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await previewPromptPolicy(id, { ...draft, sampleSystemPrompt: sample });
    setBusy(false);
    if (!res.success) { setError(res.error?.message || '预览失败'); return; }
    setPreview(res.data);
  };
  const save = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await savePromptPolicy(id, draft);
    setBusy(false);
    if (!res.success) { setError(res.error?.message || '保存失败'); return; }
    setNotice(`已保存版本 v${res.data.version}`); setPreview(null); await load();
  };
  const rollback = async (targetVersion: number) => {
    if (!data?.current || !window.confirm(`回滚到 v${targetVersion}？系统会创建一个新版本，不覆盖历史。`)) return;
    setBusy(true); setError(null);
    const res = await rollbackPromptPolicy(id, data.current.version, targetVersion);
    setBusy(false);
    if (!res.success) { setError(res.error?.message || '回滚失败'); return; }
    setNotice(`已从 v${targetVersion} 创建 v${res.data.version}`); await load();
  };
  if (!data && !error) return <SectionLoader text="正在加载提示词策略…" />;

  return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header><Link to="/app-callers" style={{ color: 'var(--accent)', fontSize: 12 }}>返回调用方</Link><h1 style={{ margin: '8px 0 0', fontSize: 18 }}>提示词策略</h1>
        <p style={hint}>{data ? `${data.appCallerCode} · ${data.requestType}` : error}</p></header>
      {error ? <div style={errorStyle}>{error}</div> : null}{notice ? <div style={noticeStyle}>{notice}</div> : null}
      <section style={card}>
        <h2 style={heading}>它有什么用</h2>
        <p style={hint}>它像贴在这个 appCaller 门口的一张工作说明。每次 chat 或 vision 请求进来时，Gateway 自动把“固定开场要求”放在业务自己的要求前面，把“固定收尾要求”放在后面。策略正文不会写入请求日志；日志只记录策略 id、版本和 hash，便于确认当时用了哪一版。</p>
      </section>
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div><strong>当前版本</strong><div style={hint}>{data?.current ? `v${data.current.version} · ${data.current.policyHash.slice(0, 12)} · ${data.current.policyChars} 个模板字符` : '尚未创建'}</div></div>
          <label style={label}><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>
        </div>
        <div className="lg-prompt-policy-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <TextArea label="固定开场要求（System Prompt 前缀）" value={draft.systemPromptPrefix} onChange={(value) => setDraft({ ...draft, systemPromptPrefix: value })} />
          <TextArea label="固定收尾要求（System Prompt 后缀）" value={draft.systemPromptSuffix} onChange={(value) => setDraft({ ...draft, systemPromptSuffix: value })} />
        </div>
        <div style={{ marginTop: 12 }}><div style={label}>可替换信息（只勾选正文实际使用的项）</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>{VARIABLES.map((name) => <label key={name} style={checkLabel}><input type="checkbox" checked={draft.allowedVariables.includes(name)} onChange={(e) => setDraft({ ...draft, allowedVariables: e.target.checked ? [...draft.allowedVariables, name] : draft.allowedVariables.filter((x) => x !== name) })} />{`{{${name}}}`}</label>)}</div></div>
        <label style={{ ...label, marginTop: 12 }}>策略字符上限<input type="number" min={1} max={20000} value={draft.maxChars} onChange={(e) => setDraft({ ...draft, maxChars: Number(e.target.value) })} style={inputStyle} /></label>
        <p style={hint}>合并顺序固定为固定开场要求、请求自身 system prompt、固定收尾要求。首版只应用 chat/vision；raw、图片生成、视频和 ASR 不注入。模板字符数不含变量替换后的长度，预览会显示本次真正生效的字符数。</p>
        <div style={{ display: 'flex', gap: 8 }}><Button onClick={() => void runPreview()} disabled={busy}>预览</Button><Button variant="primary" onClick={() => void save()} disabled={busy}>保存新版本</Button></div>
      </section>
      <section style={card}><h2 style={heading}>预览</h2><TextArea label="示例请求 system prompt" value={sample} onChange={setSample} />
        {preview ? <div style={{ marginTop: 10 }}><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}><Chip label={`${preview.policyChars} 个本次生效字符`} color="#58a6ff" bg="rgba(88,166,255,.14)" /><Chip label={`${preview.mergedChars} 个合并后字符`} color="#58a6ff" bg="rgba(88,166,255,.14)" /><Chip label={`hash ${preview.policyHash.slice(0, 12)}`} color="var(--text-primary)" bg="var(--bg-elevated)" /></div><pre style={pre}>{preview.mergedSystemPrompt || '空 system prompt'}</pre></div> : <p style={hint}>修改草稿后点击预览；预览不保存、不调用付费模型。</p>}
      </section>
      <section style={card}><h2 style={heading}>版本历史</h2><p style={hint}>回滚不会改写旧记录，而是以所选版本为内容创建一个新的版本。</p>{data?.versions.length ? <div style={{ overflowX: 'auto', marginTop: 8 }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['版本','状态','hash','模板字符','更新时间','操作'].map((x) => <th key={x} style={th}>{x}</th>)}</tr></thead><tbody>{data.versions.map((item) => <tr key={item.id}><td style={td}>v{item.version}</td><td style={td}>{item.enabled ? '启用' : '禁用'}</td><td style={td}><code>{item.policyHash.slice(0, 12)}</code></td><td style={td}>{item.policyChars}</td><td style={td}>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}</td><td style={td}><Button size="sm" variant="ghost" disabled={busy || item.version === data.current?.version} onClick={() => void rollback(item.version)}>回滚</Button></td></tr>)}</tbody></table></div> : <p style={hint}>暂无版本。</p>}</section>
    </div>
  </div>;
}

function TextArea({ label: text, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label style={label}>{text}<textarea value={value} onChange={(e) => onChange(e.target.value)} rows={7} style={{ ...inputStyle, height: 'auto', padding: 9, resize: 'vertical', lineHeight: 1.5 }} /></label>; }
const card: React.CSSProperties = { padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' };
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 12 };
const checkLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-primary)', fontSize: 12 };
const inputStyle: React.CSSProperties = { height: 34, color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0 8px' };
const hint: React.CSSProperties = { margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55 };
const heading: React.CSSProperties = { margin: '0 0 10px', fontSize: 14 };
const pre: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.55 };
const th: React.CSSProperties = { textAlign: 'left', padding: 8, color: 'var(--text-muted)', fontSize: 11 };
const td: React.CSSProperties = { padding: 8, borderTop: '1px solid var(--border-subtle)', fontSize: 12 };
const errorStyle: React.CSSProperties = { ...card, color: '#f85149', background: 'rgba(248,81,73,.08)' };
const noticeStyle: React.CSSProperties = { ...card, color: '#3fb950', background: 'rgba(63,185,80,.08)' };
