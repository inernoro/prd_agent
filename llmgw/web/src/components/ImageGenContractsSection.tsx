// 生图模型契约：尺寸档位与参数格式，配在这里就生效，不用改代码、不用发版。
//
// 为什么这一段挂在上游页：配它的时机就是「刚接了个上游，里面有个新生图模型」。
// 匹配键是模型名而不是上游（同一个模型名在哪个平台上契约都一样），所以它不挂在
// 某个 Provider 下面，而是这一页的第三段。
//
// 生效不是即时的（prd-api 每 60 秒刷一次），这一点写在界面上而不是让人保存完盯着屏幕猜。
import { useEffect, useState } from 'react';
import { createImageGenConfig, deleteImageGenConfig, getImageGenConfigs, updateImageGenConfig } from '@/lib/api';
import type { ImageGenConfigItem, ImageGenConfigsData, UpsertImageGenConfigRequest } from '@/lib/types';
import { Button, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { RowActions } from '@/components/RowActions';
import { useDialogs } from '@/components/ConfirmDialog';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, TABLE_CELL, TABLE_HEAD_CELL } from '@/lib/typography';

const BUCKETS = ['1k', '2k', '4k'] as const;
const SIZE_FORMATS = ['WxH', '{width,height}', 'aspect_ratio', 'none'] as const;
const CONSTRAINTS = ['whitelist', 'range', 'aspect_ratio', 'adaptive'] as const;

type Draft = UpsertImageGenConfigRequest & { sizeText?: Record<string, string> };

/** 尺寸在表单里是一行一个，存回去是数组——这里只做这一件事，不顺手改别的。 */
function draftToRequest(draft: Draft): UpsertImageGenConfigRequest {
  const sizes: Record<string, string[]> = {};
  for (const bucket of BUCKETS) {
    const lines = (draft.sizeText?.[bucket] ?? '')
      .split(/[\n,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (lines.length > 0) sizes[bucket] = lines;
  }
  const { sizeText, ...rest } = draft;
  void sizeText;
  return { ...rest, sizesByResolution: sizes };
}

function itemToDraft(item: ImageGenConfigItem | null): Draft {
  if (!item) {
    return {
      modelIdPattern: '',
      matchOrder: 100,
      enabled: true,
      sizeParamFormat: 'WxH',
      sizeConstraintType: 'whitelist',
      supportsResponseFormat: true,
      sizeText: { '1k': '', '2k': '', '4k': '' },
    };
  }
  const sizeText: Record<string, string> = {};
  for (const bucket of BUCKETS) sizeText[bucket] = (item.sizesByResolution?.[bucket] ?? []).join('\n');
  return { ...item, sizeText };
}

/**
 * 「我配的那条到底生效了没有」——这一句必须是可核对的，不能只说「最长 60 秒」。
 *
 * 服务端每轮同步会回写「几点同步的、认到了哪几个模式」，所以这里能逐条对：
 * 配了但服务端还没认到的，点名说出来，而不是让人保存完盯着屏幕猜（expectation-management）。
 */
function syncNote(data: ImageGenConfigsData): string {
  // 两个进程各跑一份同步器（prd-api 与 llmgw-serving），各有一份进程全局的注册表。
  // 没跟上的那个要被点名：只给一个汇总时间的话，健康的那个就替失败的那个作答了，
  // 而走失败那个进程的请求还在用旧契约（degradation-must-alarm）。
  const missing = (data.syncHosts ?? []).filter((x) => !x.syncedAt).map((x) => x.hostRole);
  if (missing.length > 0) {
    return `${missing.join('、')} 还没同步过这份契约——走它的请求仍用代码内置那份。`
      + `每 ${data.refreshSeconds} 秒拉一次，稍等再看；一直是这句说明那个进程没起来。`;
  }
  if (!data.syncedAt) {
    return `服务端还没同步过这份契约——它每 ${data.refreshSeconds} 秒拉一次，稍等再看。`;
  }
  const synced = new Set(data.syncedPatterns);
  const pending = data.items.filter((x) => x.enabled && !synced.has(x.modelIdPattern)).map((x) => x.modelIdPattern);
  const when = new Date(data.syncedAt).toLocaleTimeString();
  const scope = (data.syncHosts ?? []).length > 1 ? `全部 ${data.syncHosts.length} 个进程都在 ${when} 之后同步过` : `服务端 ${when} 同步过`;

  // 多租户进程（llmgw-serving）按请求密钥判定租户，而覆盖表是进程全局的、没有租户维度，
  // 所以它一条带租户的契约都不装。这句话必须说出口：不说的话，这一屏只会显示
  // 「0 条已生效……稍等再看」，而那是一句永远不会兑现的话——人会去查一个没坏的东西
  // （degradation-must-alarm：降级必须响铃，不能被另一半的成功盖住）。
  const skipped = (data.syncHosts ?? []).filter((x) => x.skippedTenantScopedCount > 0);
  const skipNote = skipped.length > 0
    ? ` ${skipped.map((x) => `${x.hostRole} 跳过了 ${x.skippedTenantScopedCount} 条`).join('、')}`
      + `：它按请求密钥判定租户、可能同时服务多个租户，而这张覆盖表是进程全局的、没有租户维度，`
      + `装进去会让一个租户配的尺寸改写另一个租户的请求。走它的生图请求用代码内置那份，`
      + `再等也不会变——要让契约在网关那一侧生效，得先给注册表补上租户维度。`
    : '';

  if (pending.length === 0) {
    return `${scope}，${data.syncedPatterns.length} 条已生效。${skipNote}`;
  }
  if (skipNote) {
    return `${scope}，${data.syncedPatterns.length} 条在全部进程都已生效。${skipNote}`;
  }
  return `${scope}，${data.syncedPatterns.length} 条已生效；${pending.join('、')} 还没被认到，最长 ${data.refreshSeconds} 秒后再看。`;
}

function summarizeSizes(item: ImageGenConfigItem): string {
  if (item.sizesNotApplicable) return '不选尺寸';
  const parts = BUCKETS
    .map((b) => [b, item.sizesByResolution?.[b]?.length ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([b, n]) => `${b} ${n} 档`);
  return parts.length > 0 ? parts.join(' · ') : '未配尺寸';
}

export function ImageGenContractsSection({ canWrite }: { canWrite: boolean }) {
  const { confirm } = useDialogs();
  const [data, setData] = useState<ImageGenConfigsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBuiltin, setShowBuiltin] = useState(false);

  const load = async () => {
    const res = await getImageGenConfigs();
    if (!res.success) { setError(res.error?.message || '读取生图契约失败'); return; }
    setError(null);
    setData(res.data);
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    const body = draftToRequest(editing.draft);
    const res = editing.id
      ? await updateImageGenConfig(editing.id, body)
      : await createImageGenConfig(body);
    setBusy(false);
    if (!res.success) { setError(res.error?.message || '保存失败'); return; }
    setError(null);
    setEditing(null);
    await load();
  };

  const remove = async (item: ImageGenConfigItem) => {
    const ok = await confirm({
      title: '删掉这条契约？',
      description: `${item.modelIdPattern} 的契约删掉之后，匹配到它的模型会回落到代码内置那份（如果有）。`,
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await deleteImageGenConfig(item.id);
    if (!res.success) { setError(res.error?.message || '删除失败'); return; }
    await load();
  };

  if (!data) return <SectionLoader text="正在读生图契约…" />;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 className="lg-title" style={{ margin: 0 }}>生图契约</h3>
          <p style={{ ...HINT_TEXT, margin: '4px 0 0' }}>
            新生图模型的尺寸档位与参数格式配在这里就生效，不用改代码也不用发版。
            这里配的赢；没配的回落到代码内置的 {data.builtinCount} 条。
          </p>
          <p style={{ ...HINT_TEXT, margin: '4px 0 0' }}>{syncNote(data)}</p>
        </div>
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setEditing({ id: null, draft: itemToDraft(null) })}>
            新增契约
          </Button>
        ) : null}
      </header>

      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

      {data.items.length === 0 ? (
        <p style={{ ...HINT_TEXT, margin: 0 }}>
          还没有配过契约，生图全部走代码内置那 {data.builtinCount} 条。
          上游出了内置表里没有的新模型时，在这里加一条。
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TABLE_HEAD_CELL}>匹配模式</th>
                <th style={TABLE_HEAD_CELL}>模型</th>
                <th style={TABLE_HEAD_CELL}>尺寸</th>
                <th style={TABLE_HEAD_CELL}>参数格式</th>
                <th style={TABLE_HEAD_CELL}>顺序</th>
                <th style={TABLE_HEAD_CELL} />
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td style={TABLE_CELL}>
                    <code>{item.modelIdPattern}</code>
                    {!item.enabled ? <Chip label="已停用" color="var(--text-muted)" bg="var(--bg-elevated)" /> : null}
                  </td>
                  <td style={TABLE_CELL}>
                    {item.displayName || '（未命名）'}
                    {item.provider ? <span style={HINT_TEXT}> · {item.provider}</span> : null}
                  </td>
                  <td style={TABLE_CELL}>{summarizeSizes(item)}</td>
                  <td style={TABLE_CELL}><code>{item.sizeParamFormat}</code></td>
                  <td style={TABLE_CELL}>{item.matchOrder}</td>
                  <td style={TABLE_CELL}>
                    {canWrite ? (
                      <RowActions
                        actions={[
                          { key: 'edit', label: '编辑', onSelect: () => setEditing({ id: item.id, draft: itemToDraft(item) }) },
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

      {/* 内置那份：只读，但可以「照这条建一份」——比从零填二十个字段现实得多。
          它由 prd-api 启动时发布进库，不是前端或控制台手抄的。 */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowBuiltin((v) => !v)}>
          {showBuiltin ? '收起内置契约' : `看代码内置的 ${data.builtinCount} 条`}
        </Button>
        {data.builtinPublishedAt ? (
          <span style={{ ...HINT_TEXT, marginLeft: 8 }}>由服务端发布于 {data.builtinPublishedAt}</span>
        ) : (
          <span style={{ ...HINT_TEXT, marginLeft: 8 }}>
            服务端还没发布过内置清单——prd-api 起来之后这里才有内容
          </span>
        )}
        {showBuiltin ? (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {data.builtin.map((item) => (
                  <tr key={item.modelIdPattern}>
                    <td style={TABLE_CELL}><code>{item.modelIdPattern}</code></td>
                    <td style={TABLE_CELL}>{item.displayName}</td>
                    <td style={TABLE_CELL}>{summarizeSizes(item)}</td>
                    <td style={TABLE_CELL}>
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing({
                            id: null,
                            draft: { ...itemToDraft(item), modelIdPattern: item.modelIdPattern, matchOrder: 50 },
                          })}
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
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <strong>{editing.id ? '编辑契约' : '新增契约'}</strong>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={FIELD_LABEL}>模型匹配模式</span>
            <input
              id="imagegen-pattern"
              style={FIELD_INPUT}
              value={editing.draft.modelIdPattern ?? ''}
              placeholder="nano-banana*"
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, modelIdPattern: e.target.value } })}
            />
            <span style={HINT_TEXT}>通配符只能放结尾。越具体的模式把顺序调小，让它先匹配。</span>
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
              <span style={FIELD_LABEL}>显示名</span>
              <input
                id="imagegen-display-name"
                style={FIELD_INPUT}
                value={editing.draft.displayName ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, displayName: e.target.value } })}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
              <span style={FIELD_LABEL}>供应方</span>
              <input
                id="imagegen-provider"
                style={FIELD_INPUT}
                value={editing.draft.provider ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, provider: e.target.value } })}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
              <span style={FIELD_LABEL}>匹配顺序</span>
              <input
                id="imagegen-order"
                style={FIELD_INPUT}
                type="number"
                value={editing.draft.matchOrder ?? 100}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, matchOrder: Number(e.target.value) } })}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
              <span style={FIELD_LABEL}>尺寸参数格式</span>
              <select
                id="imagegen-size-format"
                style={FIELD_INPUT}
                value={editing.draft.sizeParamFormat ?? 'WxH'}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, sizeParamFormat: e.target.value } })}
              >
                {SIZE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
              <span style={FIELD_LABEL}>尺寸约束类型</span>
              <select
                id="imagegen-constraint"
                style={FIELD_INPUT}
                value={editing.draft.sizeConstraintType ?? 'whitelist'}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, sizeConstraintType: e.target.value } })}
              >
                {CONSTRAINTS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="imagegen-sizes-na"
              type="checkbox"
              checked={editing.draft.sizesNotApplicable ?? false}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, sizesNotApplicable: e.target.checked } })}
            />
            <span>这个模型没有「选尺寸」这件事（输出尺寸由输入或 prompt 决定）</span>
          </label>

          {!editing.draft.sizesNotApplicable ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {BUCKETS.map((bucket) => (
                <label key={bucket} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                  <span style={FIELD_LABEL}>{bucket} 档尺寸</span>
                  <textarea
                    id={`imagegen-sizes-${bucket}`}
                    style={{ ...FIELD_INPUT, minHeight: 74, fontFamily: 'var(--font-mono, monospace)' }}
                    placeholder={'1024x1024\n1024x1536'}
                    value={editing.draft.sizeText?.[bucket] ?? ''}
                    onChange={(e) => setEditing({
                      ...editing,
                      draft: { ...editing.draft, sizeText: { ...editing.draft.sizeText, [bucket]: e.target.value } },
                    })}
                  />
                </label>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {([
              ['supportsImageToImage', '支持图生图'],
              ['supportsInpainting', '支持局部重绘'],
              ['supportsResponseFormat', '接受 response_format 字段'],
              ['requiresResolutionParam', '需要 resolution 参数'],
              ['injectSizePrompt', '把尺寸也写进 prompt 兜底'],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  id={`imagegen-${key}`}
                  type="checkbox"
                  checked={Boolean(editing.draft[key])}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, [key]: e.target.checked } })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={FIELD_LABEL}>官方文档链接</span>
            <input
              id="imagegen-doc-url"
              style={FIELD_INPUT}
              value={editing.draft.officialDocUrl ?? ''}
              placeholder="https://..."
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, officialDocUrl: e.target.value } })}
            />
            <span style={HINT_TEXT}>填了它，下一个来核对契约的人不用满世界找。</span>
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中' : '保存'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
