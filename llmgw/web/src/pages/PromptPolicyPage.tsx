// 提示词策略：给单个 appCaller 的 chat / vision 请求补上固定的开场与收尾要求。
//
// 「控制台风格调性 v1.2」迁移要点（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md 原则 6 / 7）：
//   - 走 PageShell 骨架、贴边全宽；此前是 maxWidth:1040 居中，宽屏两侧空转。
//     去掉居中必须和「正文改走 .lg-prose」同批做，否则段落会横跨整屏。
//   - 文字预算：原来「它有什么用」整张卡片、合并顺序说明、回滚说明共 3 段常驻正文。
//     合并顺序与日志口径收进默认收起的 DetailsBlock 并深链教程第 20 章；
//     字符数口径与回滚语义收进字段旁的 HelpPopover。常驻只留一句空态提示。
//   - 原来的 hint / pre 用 12px（--fs-caption）配 1.55 行高排成句解释，
//     现已改回正文档：用户要读的内容一律 --fs-body（见 lib/typography.ts 判定口诀）。
//   - 卡片内边距统一 CARD_BODY(14)，合并结果块用 INSET_BLOCK(10)，不再另拍 12。
//
// 跨模块契约：prd-api 的 GatewayDataDomainGuardTests 按字面量断言本文件三处用户可见文案——
// 当前版本行的模板字符计数、预览 chip 的生效字符计数、折叠块里那句日志只写元数据的口径。
// 改这三处措辞会让 CI 的 dotnet test 变红，动手前先读那个测试。
// （此处刻意不复制那三个字面量：注释里再抄一份，会让守卫在 UI 文案被删后仍然误判通过。）
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { rollbackPromptPolicy, getPromptPolicy, previewPromptPolicy, savePromptPolicy } from '@/lib/api';
import type { PromptPolicyData, PromptPolicyDraft, PromptPolicyPreview, PromptPolicyVersion } from '@/lib/types';
import { Button, Card, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { CARD_ACTIONS, CARD_BODY, GAP, INSET_BLOCK } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE, TABLE_CELL, TABLE_HEAD_CELL } from '@/lib/typography';
import { callerWorkspaceReturnHref } from '@/lib/appCallerDefaultModel';
import { mutationOutcomeUnknown } from '@/lib/mutationOutcome';
import { useDialogs } from '@/components/ConfirmDialog';

// Both endpoints reject these before inserting a new version; duplicate-version CAS is also a no-write rejection.
const POLICY_WRITE_REJECTED = ['INVALID_INPUT', 'NOT_FOUND', 'PROMPT_POLICY_VERSION_CONFLICT'] as const;

const VARIABLES = ['tenantId', 'teamId', 'appCallerCode', 'requestType', 'sourceSystem'];
const emptyDraft: PromptPolicyDraft = { expectedVersion: 0, systemPromptPrefix: '', systemPromptSuffix: '', enabled: true, allowedVariables: [], maxChars: 8000 };

export function PromptPolicyPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const currentId = useRef(id); currentId.current = id;
  const loadSerial = useRef(0);
  const operationSerial = useRef(0);
  const busyRef = useRef(false);
  const { confirm } = useDialogs();
  const [data, setData] = useState<PromptPolicyData | null>(null);
  const [draft, setDraft] = useState<PromptPolicyDraft>(emptyDraft);
  const [sample, setSample] = useState('你是一个可靠的助手。');
  const [previewRecord, setPreview] = useState<{ input: string; result: PromptPolicyPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'ok' | 'info'>('ok');
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [reading, setReading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const previewInput = JSON.stringify([id, draft, sample]);
  const preview = previewRecord?.input === previewInput ? previewRecord.result : null;
  const dirty = data ? contentKey(draft) !== contentKey(policyDraft(data.current)) : false;
  function begin(write: boolean) {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setWriting(write); setError(null); setNotice(null);
    return ++operationSerial.current;
  }
  function adoptVersion(version: PromptPolicyVersion) {
    setData(previous => previous ? { ...previous, current: version, versions: [version, ...previous.versions.filter(item => item.id !== version.id)] } : previous);
    setDraft(policyDraft(version)); setPreview(null); setConflict(false); setNeedsReconcile(false);
  }
  function finish(operation: number) {
    if (operation !== operationSerial.current) return;
    busyRef.current = false; setBusy(false); setWriting(false);
  }


  const load = async () => {
    if (id !== currentId.current) return;
    const serial = ++loadSerial.current;
    setReading(true); setError(null);
    try {
      const res = await getPromptPolicy(id);
      if (serial !== loadSerial.current || id !== currentId.current) return;
      if (!res.success) { setError(res.error?.message || '加载失败'); return; }
      setData(res.data); setDraft(policyDraft(res.data.current)); setPreview(null);
      setConflict(false); setNeedsReconcile(false);
    } catch { if (serial === loadSerial.current) setError('提示词策略读取失败，请重新读取。'); }
    finally { if (serial === loadSerial.current) setReading(false); }
  };
  useEffect(() => {
    operationSerial.current++; busyRef.current = false; setBusy(false); setWriting(false);
    setData(null); setPreview(null); setNotice(null); setConflict(false); setNeedsReconcile(false);
    void load();
    return () => { loadSerial.current++; operationSerial.current++; };
  }, [id]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runPreview = async () => {
    const operation = begin(false); if (operation === null) return;
    const input = previewInput;
    try {
      const res = await previewPromptPolicy(id, { ...draft, sampleSystemPrompt: sample });
      if (operation !== operationSerial.current) return;
      if (!res.success) { setError(res.error?.message || '预览失败'); return; }
      setPreview({ input, result: res.data });
    } catch { if (operation === operationSerial.current) setError('预览未完成，请重试。'); }
    finally { finish(operation); }
  };
  const save = async () => {
    if (needsReconcile || conflict) return;
    const operation = begin(true); if (operation === null) return;
    try {
      const res = await savePromptPolicy(id, draft);
      if (operation !== operationSerial.current) return;
      if (!res.success) {
        const versionConflict = res.error?.code === 'PROMPT_POLICY_VERSION_CONFLICT';
        const unknown = mutationOutcomeUnknown(res.error?.code, POLICY_WRITE_REJECTED);
        setConflict(versionConflict);
        setNeedsReconcile(unknown);
        setError(unknown ? '保存结果未确认，可能已生效；本地草稿已保留，请先核对服务端版本。' : versionConflict ? '服务端版本已变更，本地草稿已保留。请读取最新版本后再编辑。' : res.error?.message || '保存请求被拒绝'); return;
      }
      adoptVersion(res.data); setNoticeTone('ok'); setNotice(`已保存版本 v${res.data.version}`); await load();
    } catch { if (operation === operationSerial.current) { setNeedsReconcile(true); setError('保存结果未知，草稿已保留，请核对服务端版本。'); } }
    finally { finish(operation); }
  };
  const rollback = async (targetVersion: number) => {
    if (!data?.current || needsReconcile || conflict) return;
    const operation = begin(true); if (operation === null) return;
    try {
      if (!await confirm({ title: `回滚到 v${targetVersion}？`, description: `系统会创建新版本，不覆盖历史。${dirty ? '当前未保存草稿会被替换。' : ''}`, confirmLabel: '回滚' })) return;
      if (operation !== operationSerial.current) return;
      const res = await rollbackPromptPolicy(id, data.current.version, targetVersion);
      if (operation !== operationSerial.current) return;
      if (!res.success) {
        const versionConflict = res.error?.code === 'PROMPT_POLICY_VERSION_CONFLICT';
        const unknown = mutationOutcomeUnknown(res.error?.code, POLICY_WRITE_REJECTED);
        setConflict(versionConflict);
        setNeedsReconcile(unknown);
        setError(unknown ? '回滚结果未确认，可能已生效；本地草稿已保留，请先核对服务端版本。' : versionConflict ? '服务端版本已变更，本地草稿已保留。请读取最新版本后再编辑。' : res.error?.message || '回滚请求被拒绝'); return;
      }
      adoptVersion(res.data); setNoticeTone('ok'); setNotice(`已从 v${targetVersion} 创建 v${res.data.version}`); await load();
    } catch { if (operation === operationSerial.current) { setNeedsReconcile(true); setError('回滚结果未知，草稿已保留，请核对服务端版本。'); } }
    finally { finish(operation); }
  };
  const reconcile = async () => {
    const operation = begin(true); if (operation === null) return;
    try {
      const res = await getPromptPolicy(id);
      if (operation !== operationSerial.current) return;
      if (!res.success) { setError(res.error?.message || '版本核对失败'); return; }
      setData(res.data); setNeedsReconcile(false);
      if (contentKey(draft) === contentKey(policyDraft(res.data.current))) {
        setDraft(policyDraft(res.data.current)); setConflict(false);
        setNoticeTone('info'); setNotice(`当前服务端 v${res.data.current?.version || 0} 内容与草稿一致`);
      } else {
        const changed = (res.data.current?.version || 0) !== draft.expectedVersion;
        setConflict(changed);
        if (changed) setError('服务端版本已变更，本地草稿保留；复制需要的内容后可丢弃草稿读取最新。');
        else { setNoticeTone('info'); setNotice('已核对当前版本，草稿尚未保存，可以继续编辑或保存。'); }
      }
    } catch { if (operation === operationSerial.current) setError('版本核对未完成，草稿仍保留。'); }
    finally { finish(operation); }
  };

  return (
    <PageShell>
      <PageHeader
        title="提示词策略"
        subtitle="为当前调用方的这个请求类型补上固定的开场与收尾要求。"
        summary={data ? (
          <>
            <code style={MONO_META}>{data.appCallerCode}</code>
            <span>请求类型 <strong>{data.requestType}</strong></span>
            <span>{data.current ? <>{needsReconcile || conflict ? '上次读取' : '当前'} <strong>v{data.current.version}</strong>{needsReconcile || conflict ? ' · 当前待核' : ''}</> : needsReconcile || conflict ? '上次读取：尚未创建 · 当前待核' : '尚未创建'}</span>
          </>
        ) : undefined}
        actions={<Link to={data ? callerWorkspaceReturnHref(data.appCallerCode, data.requestType, params.get('callerReturn') || '') : '/app-callers'} style={backLinkStyle}><ArrowLeft size={14} />返回调用方</Link>}
      />

      <PageBody>
        {error || needsReconcile || conflict ? <InlineAlert tone="error">{error || (needsReconcile ? '保存结果待核对，本地草稿保留。' : '服务端版本已变更，本地草稿保留。')}{!data ? <Button size="sm" variant="ghost" onClick={() => void load()}>重新读取</Button> : null}{needsReconcile ? <Button size="sm" variant="ghost" disabled={busy || reading} onClick={() => void reconcile()}>核对服务端版本（保留草稿）</Button> : null}{conflict ? <Button size="sm" variant="ghost" disabled={busy || reading} onClick={() => void load()}>丢弃本地草稿并读取最新</Button> : null}</InlineAlert> : null}
        {notice ? <InlineAlert tone={noticeTone}>{notice}</InlineAlert> : null}
        {reading && data ? <SectionLoader text="正在读取最新版本…" /> : null}

        {!data ? (
          error ? null : <SectionLoader text="正在加载提示词策略…" />
        ) : (
          <>
            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>策略正文</h2>{dirty ? <span style={HINT_TEXT} role="status">有未保存更改</span> : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap' }}>
                  <span style={HINT_TEXT}>
                    {needsReconcile || conflict ? '上次读取 · ' : ''}{data.current ? `v${data.current.version} · ${data.current.policyHash.slice(0, 12)} · ${data.current.policyChars} 个模板字符` : '尚未创建'}{needsReconcile || conflict ? ' · 当前待核' : ''}
                  </span>
                  <label style={checkStyle}>
                    <input type="checkbox" disabled={writing || reading} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用
                  </label>
                </div>
              </div>

              <div className="lg-prompt-policy-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP.section }}>
                <TextArea disabled={writing || reading} label="固定开场要求（System Prompt 前缀）" value={draft.systemPromptPrefix} onChange={(value) => setDraft({ ...draft, systemPromptPrefix: value })} />
                <TextArea disabled={writing || reading} label="固定收尾要求（System Prompt 后缀）" value={draft.systemPromptSuffix} onChange={(value) => setDraft({ ...draft, systemPromptSuffix: value })} />
              </div>

              <div style={{ marginTop: GAP.section }}>
                <div style={FIELD_LABEL}>
                  <span>
                    可替换信息
                    <HelpPopover label="可替换信息">
                      只勾选策略正文里实际写到的项。勾选后，Gateway 在合并时把 <code>{'{{变量名}}'}</code> 换成本次请求的真实值；
                      没勾选的变量不参与替换。
                    </HelpPopover>
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.normal, marginTop: GAP.tight }}>
                  {VARIABLES.map((name) => (
                    <label key={name} style={checkStyle}>
                      <input
                        type="checkbox"
                        disabled={writing || reading}
                        checked={draft.allowedVariables.includes(name)}
                        onChange={(e) => setDraft({
                          ...draft,
                          allowedVariables: e.target.checked
                            ? [...draft.allowedVariables, name]
                            : draft.allowedVariables.filter((x) => x !== name),
                        })}
                      />
                      {`{{${name}}}`}
                    </label>
                  ))}
                </div>
              </div>

              <FormGrid style={{ marginTop: GAP.section }}>
                <label style={FIELD_LABEL}>
                  <span>
                    策略字符上限
                    <HelpPopover label="策略字符上限">
                      版本历史里的模板字符数的是策略正文本身，不含变量替换后的长度；预览会另外显示本次真正生效的字符数。
                      两个数字通常不相等，用了变量就以预览为准。
                    </HelpPopover>
                  </span>
                  <input disabled={writing || reading} type="number" min={1} max={20000} value={draft.maxChars} onChange={(e) => setDraft({ ...draft, maxChars: Number(e.target.value) })} style={FIELD_INPUT} />
                </label>
              </FormGrid>

              <div style={{ ...CARD_ACTIONS, marginTop: GAP.section }}>
                <Button size="sm" onClick={() => void runPreview()} disabled={busy || reading}>预览</Button>
                <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || reading || needsReconcile || conflict}>保存新版本</Button>
              </div>
            </Card>

            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}><h2 style={SECTION_TITLE}>预览</h2></div>
              <TextArea disabled={writing || reading} label="示例请求 system prompt" value={sample} onChange={setSample} />
              {preview ? (
                <div style={{ marginTop: GAP.normal }}>
                  <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap' }}>
                    <Chip label={`${preview.policyChars} 个本次生效字符`} color="var(--accent)" bg="var(--accent-soft)" />
                    <Chip label={`${preview.mergedChars} 个合并后字符`} color="var(--accent)" bg="var(--accent-soft)" />
                    <Chip label={`hash ${preview.policyHash.slice(0, 12)}`} color="var(--text-primary)" bg="var(--bg-elevated)" />
                  </div>
                  <pre style={preStyle}>{preview.mergedSystemPrompt || '空 system prompt'}</pre>
                </div>
              ) : (
                <Prose style={{ marginTop: GAP.normal }}>改完草稿点预览；预览不保存、不调用付费模型。</Prose>
              )}
            </Card>

            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>版本历史</h2>
                <span style={HINT_TEXT}>
                  回滚
                  <HelpPopover label="回滚" align="end">
                    回滚不会改写旧记录，而是以所选版本为内容创建一个新的版本，历史因此始终可追溯。
                  </HelpPopover>
                </span>
              </div>
              {data.versions.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="lg-data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>{['版本', '状态', 'hash', '模板字符', '更新时间', '操作'].map((x) => <th key={x} style={TABLE_HEAD_CELL}>{x}</th>)}</tr>
                    </thead>
                    <tbody>
                      {data.versions.map((item) => (
                        <tr key={item.id}>
                          <td style={TABLE_CELL}>v{item.version}</td>
                          <td style={TABLE_CELL}>{item.enabled ? '启用' : '禁用'}</td>
                          <td style={{ ...TABLE_CELL, ...MONO_META }}><code>{item.policyHash.slice(0, 12)}</code></td>
                          <td style={TABLE_CELL}>{item.policyChars}</td>
                          <td style={TABLE_CELL}>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}</td>
                          <td style={{ ...TABLE_CELL, textAlign: 'right' }}>
                            <Button size="sm" variant="ghost" disabled={busy || reading || needsReconcile || conflict || item.version === data.current?.version} onClick={() => void rollback(item.version)}>回滚</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Prose>还没有版本。填好上面的开场与收尾要求，保存后这里会出现第一条记录。</Prose>
              )}
            </Card>

            <DetailsBlock title="工作原理：策略怎么合并进请求">
              <Prose>
                它像贴在这个 appCaller 门口的一张工作说明。每次 chat 或 vision 请求进来时，Gateway 自动把“固定开场要求”
                放在业务自己的要求前面，把“固定收尾要求”放在后面，合并顺序固定为固定开场要求、请求自身 system prompt、
                固定收尾要求。首版只应用 chat/vision；raw、图片生成、视频和 ASR 不注入。
              </Prose>
              <Prose>
                策略正文不会写入请求日志；日志只记录策略 id、版本和 hash，便于确认当时用了哪一版。
              </Prose>
              <TutorialLink chapter="chapter-20">查看教程：第 20 章 提示词策略</TutorialLink>
            </DetailsBlock>
          </>
        )}
      </PageBody>
    </PageShell>
  );
}

function policyDraft(current?: PromptPolicyVersion | null): PromptPolicyDraft {
  return current ? { expectedVersion: current.version, systemPromptPrefix: current.systemPromptPrefix, systemPromptSuffix: current.systemPromptSuffix, enabled: current.enabled, allowedVariables: current.allowedVariables, maxChars: current.maxChars } : { ...emptyDraft, allowedVariables: [] };
}
function contentKey(draft: PromptPolicyDraft) { return JSON.stringify({ ...draft, expectedVersion: 0 }); }

/** 策略正文与示例：多行输入同样是用户要读的内容，走 FIELD_INPUT 的正文档。 */
function TextArea({ label: text, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label style={FIELD_LABEL}>
      <span>{text}</span>
      <textarea
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        style={{ ...FIELD_INPUT, height: 'auto', padding: 10, resize: 'vertical', lineHeight: 'var(--lh-body)' }}
      />
    </label>
  );
}

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: GAP.section,
  flexWrap: 'wrap',
  marginBottom: GAP.normal,
};
const checkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-body)',
};
const backLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  minHeight: 32,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-secondary)',
  textDecoration: 'none',
};
/** 合并结果：卡片内的次级块，内边距只允许 INSET_PADDING(10)。 */
const preStyle: React.CSSProperties = {
  ...INSET_BLOCK,
  margin: `${GAP.normal}px 0 0`,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
};
