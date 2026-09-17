// 模型名录补登：「这个模型是什么」，在这里登记一次就算数，不用改代码也不用发版。
//
// 为什么需要它：名录回答的是「这个模型算哪几种用途、能不能吃图」，而它此前只有写死在
// console-api 里的二十来条。实测线上两个上游共 573 个模型，落在名录里的只有 27 个——
// 其余 95% 走关键词猜测，其中一百多个连一条用途都猜不出来，导进来就是「哑」模型：
// 模型池选型时不参与任何用途匹配。
//
// 合并规则只有一条，且只实现在 ModelCatalog.Find 里：
// **同一个标识，补登的赢；补登里没有的，回落到代码内置那张表。**
// 所以是纯增量的——库里一行都没有时行为与今天逐字节相同，删光补登就回退。
//
// 与生图契约那份的区别：那份跨进程（console-api 写、prd-api 读）只能轮询、最长 60 秒生效；
// 这份只有 console-api 自己读，端点每次请求现查，所以**改完立刻生效**，界面上就这么写。
import { useEffect, useState } from 'react';
import { createCatalogEntry, deleteCatalogEntry, getCatalogEntries, updateCatalogEntry } from '@/lib/api';
import type { CatalogEntriesData, CatalogEntryItem, UpsertCatalogEntryRequest } from '@/lib/types';
import { Button, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { RowActions } from '@/components/RowActions';
import { useDialogs } from '@/components/ConfirmDialog';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, TABLE_CELL, TABLE_HEAD_CELL } from '@/lib/typography';

/** 表单草稿：等价写法在界面上是一行一个，存回去是数组。 */
export type CatalogDraft = UpsertCatalogEntryRequest & { aliasText?: string };

export function draftFromEntry(item: CatalogEntryItem | null): CatalogDraft {
  if (!item) {
    return { canonicalId: '', displayName: '', vendor: '', capabilities: [], enabled: true, aliasText: '' };
  }
  return {
    canonicalId: item.canonicalId,
    displayName: item.displayName,
    vendor: item.vendor,
    capabilities: [...item.capabilities],
    acceptsImageInput: item.acceptsImageInput,
    requiresImageInput: item.requiresImageInput,
    notes: item.notes ?? '',
    enabled: item.enabled ?? true,
    aliasText: (item.aliases ?? []).join('\n'),
  };
}

export function draftToRequest(draft: CatalogDraft): UpsertCatalogEntryRequest {
  const { aliasText, ...rest } = draft;
  return {
    ...rest,
    aliases: (aliasText ?? '')
      .split(/[\n,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

/** 用途名的人话。名录里的用途名是存储层能力名，直接摆给人看认不出是什么。 */
export function capabilityLabelCn(id: string): string {
  const map: Record<string, string> = {
    chat: '对话',
    vision: '看图',
    reasoning: '推理',
    embedding: '向量',
    rerank: '重排',
    code: '写代码',
    long_context: '长上下文',
    function_calling: '函数调用',
    structured_output: '结构化输出',
    image_generation: '生图',
    text2img: '文生图',
    img2img: '图生图',
    asr: '语音转写',
    tts: '语音合成',
  };
  return map[id] ? `${map[id]}（${id}）` : id;
}

/**
 * 补登表单。两处在用：这一页的管理区，和导入那一屏的就地补登。
 *
 * 抽成一个组件不是为了少写代码，是为了让「界面允许填什么」只有一份：
 * 两份表单各自维护一张用途清单，迟早有一边漏掉运行时新增的那一种，
 * 而漏掉的后果是「填了没用」——那是这套东西最难查的坏法。
 */
export function CatalogEntryEditor({
  draft,
  onChange,
  knownCapabilities,
  busy,
  onSave,
  onCancel,
  idPrefix = 'catalog',
  lockCanonicalId = false,
}: {
  draft: CatalogDraft;
  onChange: (next: CatalogDraft) => void;
  knownCapabilities: string[];
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  idPrefix?: string;
  lockCanonicalId?: boolean;
}) {
  const caps = new Set(draft.capabilities ?? []);
  const toggleCap = (cap: string) => {
    const next = new Set(caps);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    onChange({ ...draft, capabilities: [...next] });
  };

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
          <span style={FIELD_LABEL}>模型标识</span>
          <input
            id={`${idPrefix}-canonical-id`}
            style={{ ...FIELD_INPUT, fontFamily: 'var(--font-mono, monospace)' }}
            value={draft.canonicalId ?? ''}
            disabled={lockCanonicalId}
            placeholder="gpt-5.6-sol"
            onChange={(e) => onChange({ ...draft, canonicalId: e.target.value })}
          />
          <span style={HINT_TEXT}>上游最通用的那个写法。名录是白名单，不支持通配符——别的写法写进下面的「等价写法」。</span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
          <span style={FIELD_LABEL}>显示名</span>
          <input
            id={`${idPrefix}-display-name`}
            style={FIELD_INPUT}
            value={draft.displayName ?? ''}
            onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
          <span style={FIELD_LABEL}>出品方</span>
          <input
            id={`${idPrefix}-vendor`}
            style={FIELD_INPUT}
            value={draft.vendor ?? ''}
            placeholder="openai"
            onChange={(e) => onChange({ ...draft, vendor: e.target.value })}
          />
          <span style={HINT_TEXT}>模型的出品方，不是转售它的那个上游。</span>
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={FIELD_LABEL}>用途（至少选一种）</span>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {knownCapabilities.map((cap) => (
            <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                id={`${idPrefix}-cap-${cap}`}
                type="checkbox"
                checked={caps.has(cap)}
                onChange={() => toggleCap(cap)}
              />
              <span>{capabilityLabelCn(cap)}</span>
            </label>
          ))}
        </div>
        <span style={HINT_TEXT}>
          这几种就是运行时真正认的全部。一条用途都不选的话这条补登不解决任何问题——模型仍然不参与用途匹配。
        </span>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id={`${idPrefix}-accepts-image`}
            type="checkbox"
            checked={Boolean(draft.acceptsImageInput)}
            onChange={(e) => onChange({
              ...draft,
              acceptsImageInput: e.target.checked,
              // 取消「能吃图」时连带取消「必须给图」，否则这条登记自相矛盾、保存时被服务端退回来。
              requiresImageInput: e.target.checked ? draft.requiresImageInput : false,
            })}
          />
          <span>能接收图片输入</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id={`${idPrefix}-requires-image`}
            type="checkbox"
            disabled={!draft.acceptsImageInput}
            checked={Boolean(draft.requiresImageInput)}
            onChange={(e) => onChange({ ...draft, requiresImageInput: e.target.checked })}
          />
          <span>必须给图才能调（图片编辑类）</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id={`${idPrefix}-enabled`}
            type="checkbox"
            checked={draft.enabled !== false}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          />
          <span>启用这条补登</span>
        </label>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={FIELD_LABEL}>等价写法（一行一个）</span>
        <textarea
          id={`${idPrefix}-aliases`}
          style={{ ...FIELD_INPUT, minHeight: 64, fontFamily: 'var(--font-mono, monospace)' }}
          placeholder={'openai/gpt-5.6-sol\ngpt-5.6-sol-2026-09-01'}
          value={draft.aliasText ?? ''}
          onChange={(e) => onChange({ ...draft, aliasText: e.target.value })}
        />
        <span style={HINT_TEXT}>
          同一个模型在不同网关写法不同。写进这里它们落到同一条登记上，不用为同一个模型补登好几条。
        </span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={FIELD_LABEL}>备注</span>
        <input
          id={`${idPrefix}-notes`}
          style={FIELD_INPUT}
          value={draft.notes ?? ''}
          placeholder="依据：上游 2026-09 发布说明"
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        />
        <span style={HINT_TEXT}>写清这批用途是从哪儿核实的，下一个人不用重查一遍。</span>
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" disabled={busy} onClick={onSave}>
          {busy ? '保存中' : '保存'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

export function ModelCatalogSection({ canWrite }: { canWrite: boolean }) {
  const { confirm } = useDialogs();
  const [data, setData] = useState<CatalogEntriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: CatalogDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBuiltin, setShowBuiltin] = useState(false);

  const load = async () => {
    const res = await getCatalogEntries();
    if (!res.success) { setError(res.error?.message || '读取模型名录失败'); return; }
    setError(null);
    setData(res.data);
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    const body = draftToRequest(editing.draft);
    const res = editing.id ? await updateCatalogEntry(editing.id, body) : await createCatalogEntry(body);
    setBusy(false);
    if (!res.success) { setError(res.error?.message || '保存失败'); return; }
    setError(null);
    setEditing(null);
    await load();
  };

  const remove = async (item: CatalogEntryItem) => {
    const ok = await confirm({
      title: '删掉这条补登？',
      description: `${item.canonicalId} 删掉之后回落到代码内置那张表；内置表里也没有的话，它的用途就重新变成按模型名猜的。`,
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok || !item.id) return;
    const res = await deleteCatalogEntry(item.id);
    if (!res.success) { setError(res.error?.message || '删除失败'); return; }
    await load();
  };

  // 读失败时**先把失败摆出来**，再谈加载中。
  //
  // 顺序反了的话（先 `if (!data) return <SectionLoader/>`），首次读取失败就永远停在
  // 「正在读…」：下面那条 InlineAlert 根本到不了，人看到的是一个不会结束的等待，
  // 既不知道发生了什么，也没有任何下一步（expectation-management 的第四种失控：白等一场）。
  if (!data) {
    if (error) {
      return (
        <InlineAlert tone="error">
          {error}
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </div>
        </InlineAlert>
      );
    }
    return <SectionLoader text="正在读模型名录…" />;
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 className="lg-title" style={{ margin: 0 }}>模型名录</h3>
          <p style={{ ...HINT_TEXT, margin: '4px 0 0' }}>
            名录回答的是「这个模型是什么」——算哪几种用途、能不能吃图。名录外的模型只能按模型名猜，
            猜不出用途就是一个「哑」模型：入库了，但模型池选型时不参与任何用途匹配。
          </p>
          <p style={{ ...HINT_TEXT, margin: '4px 0 0' }}>
            这里补登的赢；没补登的回落到代码内置那 {data.builtinCount} 条。
            补完<strong>立刻生效</strong>，上游清单那一屏刷新就能看见——不用发版，也不用等任何缓存。
          </p>
        </div>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setEditing({ id: null, draft: draftFromEntry(null) })}>
            补登一个模型
          </Button>
        ) : null}
      </header>

      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

      {data.items.length === 0 ? (
        <p style={{ ...HINT_TEXT, margin: 0 }}>
          还没补登过，名录只有代码内置那 {data.builtinCount} 条。
          在上游清单里看到「名录外」的模型时，点那一行的「补登」最省事——模型标识会自动填好。
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TABLE_HEAD_CELL}>模型标识</th>
                <th style={TABLE_HEAD_CELL}>名字</th>
                <th style={TABLE_HEAD_CELL}>用途</th>
                <th style={TABLE_HEAD_CELL}>图片</th>
                <th style={TABLE_HEAD_CELL}>等价写法</th>
                <th style={TABLE_HEAD_CELL} />
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td style={TABLE_CELL}>
                    <code>{item.canonicalId}</code>
                    {item.enabled === false ? <Chip label="已停用" color="var(--text-muted)" bg="var(--bg-elevated)" /> : null}
                  </td>
                  <td style={TABLE_CELL}>
                    {item.displayName || '（未命名）'}
                    {item.vendor ? <span style={HINT_TEXT}> · {item.vendor}</span> : null}
                  </td>
                  <td style={TABLE_CELL}>
                    <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {item.capabilities.map((c) => (
                        <Chip key={c} label={c} color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={capabilityLabelCn(c)} />
                      ))}
                    </span>
                  </td>
                  <td style={TABLE_CELL}>
                    {item.requiresImageInput ? '必须给图' : item.acceptsImageInput ? '能吃图' : '—'}
                  </td>
                  <td style={TABLE_CELL}>{item.aliases.length > 0 ? `${item.aliases.length} 个` : '—'}</td>
                  <td style={TABLE_CELL}>
                    {canWrite ? (
                      <RowActions
                        actions={[
                          { key: 'edit', label: '编辑', onSelect: () => setEditing({ id: item.id ?? null, draft: draftFromEntry(item) }) },
                          { key: 'delete', label: '删除', danger: true, onSelect: () => void remove(item) },
                        ]}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 内置那份：只读，但可以「照这条建一份」——上游给老模型加了能力时，补登要能纠正它。 */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowBuiltin((v) => !v)}>
          {showBuiltin ? '收起内置名录' : `看代码内置的 ${data.builtinCount} 条`}
        </Button>
        {showBuiltin ? (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {data.builtin.map((item) => (
                  <tr key={item.canonicalId}>
                    <td style={TABLE_CELL}><code>{item.canonicalId}</code></td>
                    <td style={TABLE_CELL}>{item.displayName}</td>
                    <td style={TABLE_CELL}>{item.capabilities.join(' · ')}</td>
                    <td style={TABLE_CELL}>
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing({ id: null, draft: draftFromEntry(item) })}
                        >
                          照这条建一份
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {editing ? (
        <CatalogEntryEditor
          draft={editing.draft}
          onChange={(draft) => setEditing({ ...editing, draft })}
          knownCapabilities={data.knownCapabilities}
          busy={busy}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
          lockCanonicalId={Boolean(editing.id)}
        />
      ) : null}
    </section>
  );
}
