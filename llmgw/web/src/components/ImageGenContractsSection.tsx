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
import { Button, Chip, HelpTip, InlineAlert, SectionLoader } from '@/components/ui';
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
  // 勾了「没有选尺寸这件事」就一个档位都不提交。
  //
  // 勾选只是把输入框藏起来，草稿里原来那几行尺寸还在；照原样提交的话，服务端的
  // 「不能既说没有尺寸又配尺寸档位」会把它挡回来——于是一条**已经配过尺寸**的契约
  // 在界面上根本改不成「不选尺寸」，而报错信息说的是一个用户看不见的字段
  // （藏起来的输入框里的值）。判据收在这一处的出口，不靠勾选时去清草稿：
  // 清草稿的话用户一勾一取消，原来填的尺寸就没了。
  if (draft.sizesNotApplicable) {
    const { sizeText, ...rest } = draft;
    void sizeText;
    return { ...rest, sizesByResolution: {} };
  }
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
  const hosts = data.syncHosts ?? [];

  // 跳过说明单独成句，和「跟没跟上」是两件事：一个进程可以既是最新的、又一条本租户契约都不装。
  //
  // 多租户进程（llmgw-serving）按请求密钥判租户，而覆盖表是进程全局的、没有租户维度，
  // 所以它一条带租户的契约都不装。不说出口的话，人只会看到自己配的契约没生效而无从查起
  // （degradation-must-alarm：降级必须响铃）。
  const skipped = hosts.filter((x) => x.skippedTenantScopedCount > 0);
  const skipNote = skipped.length > 0
    ? ` ${skipped.map((x) => `${x.hostRole} 跳过了 ${x.skippedTenantScopedCount} 条`).join('、')}`
      + `：它按请求密钥判定租户、可能同时服务多个租户，而这张覆盖表是进程全局的、没有租户维度，`
      + `装进去会让一个租户配的尺寸改写另一个租户的请求。走它的生图请求用代码内置那份，`
      + `再等也不会变——要让契约在网关那一侧生效，得先给注册表补上租户维度。`
    : '';

  // 翻不过去的那几条单独成句：它与「按租户跳过」的下一步完全不同——那个要等注册表补上
  // 租户维度，这个要去把那条契约本身改掉。不说出口的话，人只会看到条数对不上而无从查起。
  const unusable = hosts.filter((x) => (x.unusablePatterns ?? []).length > 0);
  const unusableNote = unusable.length > 0
    ? ` ${unusable.map((x) => `${x.hostRole} 没装上 ${(x.unusablePatterns ?? []).join('、')}`).join('；')}`
      + `：这几条契约本身翻不过去（多半是参数改名的键只差大小写，而运行时那张表不分大小写），`
      + `其余契约照常生效。去下面把这几条改掉即可，再等不会变。`
    : '';

  // 没跟上的逐个点名，且三种「没跟上」要分开说——它们的下一步完全不同：
  // 从没回写过 / 停了太久 / 还活着但慢一拍。压成一句「未同步」，人只能干等。
  const never = hosts.filter((x) => x.syncState === 'never').map((x) => x.hostRole);
  const stale = hosts.filter((x) => x.syncState === 'stale');
  const behind = hosts.filter((x) => x.syncState === 'behind').map((x) => x.hostRole);

  const problems: string[] = [];
  if (never.length > 0) {
    problems.push(`${never.join('、')} 还没回写过同步状态——多半是进程没起来，走它的请求用代码内置那份。`);
  }
  for (const host of stale) {
    const last = host.syncedAt ? new Date(host.syncedAt).toLocaleTimeString() : '未知时间';
    problems.push(
      `${host.hostRole} 上一次回写还是 ${last}，已经超过 ${data.staleAfterSeconds} 秒没动——`
      + `它的同步器多半停了或读不到库，走它的请求仍在用旧契约。`);
  }
  if (behind.length > 0) {
    problems.push(`${behind.join('、')} 装的还不是当前这一版，最长 ${data.refreshSeconds} 秒后再看。`);
  }
  if (problems.length > 0) return problems.join(' ') + skipNote + unusableNote;

  if (!data.syncedAt) {
    return `还没有任何进程认领本租户的契约——走生图的请求用代码内置那份。${skipNote}${unusableNote}`;
  }

  const when = new Date(data.syncedAt).toLocaleTimeString();
  return `${when} 已生效，共 ${data.syncedPatterns.length} 条（承载本租户契约的进程全部装到了当前这一版）。${skipNote}${unusableNote}`;
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
  // 轮询的心跳。只靠 data 当依赖的话，一次失败的轮询什么都不会变（data 原样、
  // hostsSettled 原样），于是那个已经用掉的 timeout 再也不会被重排——页面从此停在
  // 「装的还不是当前这一版」，哪怕接口与 worker 早就恢复了。失败也要让心跳走一格。
  const [pollTick, setPollTick] = useState(0);

  const load = async () => {
    const res = await getImageGenConfigs();
    if (!res.success) { setError(res.error?.message || '读取生图契约失败'); return; }
    setError(null);
    setData(res.data);
  };
  useEffect(() => { void load(); }, []);

  /*
    没落定就按刷新周期再读一次。

    同步是 60 秒一轮的后台动作，而保存之后这里立刻重读——那一读必然还是旧版本，
    界面于是显示「装的还不是当前这一版」。只在挂载时读一次的话，它会一直停在那句话上，
    而它自己刚说过「最长 N 秒后再看」：一句不会兑现的承诺，比不说更糟
    （expectation-management：说到做到）。

    落定 = 每个进程要么装到了当前这一版，要么压根不服务这个租户。只要还有没落定的，
    就再读一次；读回来 data 换了新对象，这个 effect 自然接着排下一次，直到落定为止。
  */
  const hostsSettled = data === null
    || data.syncHosts.every((x) => x.syncState === 'current' || x.syncState === 'not-applicable');
  /*
    落定之后**放慢**，不是停掉。

    上一版落定就彻底取消轮询。可是「都跟上了」只是那一刻的事实：这一屏开着的时候，某个进程
    完全可能停掉或连不上库，而服务端要等下一次请求才把它算成 stale——没人再问，那句
    「所有进程都装着当前这一版」就无限期地挂在屏幕上，而它早就不成立了
    （第 63 轮 review；同一类毛病：拿一个时刻的结论当成持续成立的结论）。

    所以分两档：没落定时按服务端给的刷新周期追，落定之后降到十倍周期（至少一分钟）继续看着。
    降频是为了别把一屏静态信息变成一个高频轮询器，而不是为了省那几次请求。
  */
  useEffect(() => {
    if (data === null) return undefined;
    const base = Math.max(5, data.refreshSeconds);
    const seconds = hostsSettled ? Math.max(60, base * 10) : base;
    const timer = window.setTimeout(
      () => { void load().finally(() => setPollTick((x) => x + 1)); },
      seconds * 1000);
    return () => window.clearTimeout(timer);
    // pollTick 进依赖：成功时 data 换了新对象会重排，失败时 data 不变，
    // 只有这一格心跳能把下一次排上。少了它，一次网络抖动就等于永久停摆。
  }, [data, hostsSettled, pollTick]);

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

  // 同上：读失败要先摆出来再谈加载中，否则首次失败就是一个不会结束的「正在读…」。
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
    return <SectionLoader text="正在读生图契约…" />;
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 className="lg-title" style={{ margin: 0 }}>生图契约</h3>
          <HelpTip label="查看生图契约说明">
            <p style={{ margin: 0 }}>
              这里配置生图模型的尺寸档位和参数格式。配置优先生效，未配置的模型回落到代码内置的 {data.builtinCount} 条。
            </p>
            <p style={{ margin: '8px 0 0' }}>{syncNote(data)}</p>
            {data.builtinPublishedAt ? <p style={{ margin: '8px 0 0' }}>内置清单发布于 {data.builtinPublishedAt}</p> : null}
          </HelpTip>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <Button variant="secondary" size="sm" onClick={() => setShowBuiltin((value) => !value)}>
            {showBuiltin ? '查看自定义契约' : `查看内置契约（${data.builtinCount}）`}
          </Button>
          {canWrite ? (
            <Button variant="primary" size="sm" onClick={() => setEditing({ id: null, draft: itemToDraft(null) })}>
              新增契约
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <InlineAlert tone="error">
          {error}
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </div>
        </InlineAlert>
      ) : null}

      {!showBuiltin ? (
        <div data-testid="imagegen-contract-table" style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
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
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...TABLE_CELL, color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>
                  暂无生图契约
                </td>
              </tr>
            ) : data.items.map((item) => (
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
      ) : null}

      {showBuiltin ? (
        <div data-testid="imagegen-contract-table" style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
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
              {data.builtin.map((item) => (
                <tr key={item.modelIdPattern}>
                  <td style={TABLE_CELL}><code>{item.modelIdPattern}</code></td>
                  <td style={TABLE_CELL}>{item.displayName}</td>
                  <td style={TABLE_CELL}>{summarizeSizes(item)}</td>
                  <td style={TABLE_CELL}><code>{item.sizeParamFormat}</code></td>
                  <td style={TABLE_CELL}>{item.matchOrder}</td>
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
                        新建这条
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

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

          {!editing.draft.sizesNotApplicable && editing.draft.sizeConstraintType === 'range' ? (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {([
                  ['minWidth', '最小宽'],
                  ['maxWidth', '最大宽'],
                  ['minHeight', '最小高'],
                  ['maxHeight', '最大高'],
                  ['maxPixels', '最大像素总量'],
                  ['mustBeDivisibleBy', '边长必须整除'],
                ] as const).map(([key, label]) => (
                  <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
                    <span style={FIELD_LABEL}>{label}</span>
                    <input
                      id={`imagegen-${key}`}
                      type="number"
                      min={0}
                      style={FIELD_INPUT}
                      value={editing.draft[key] ?? ''}
                      onChange={(e) => setEditing({
                        ...editing,
                        draft: {
                          ...editing.draft,
                          [key]: e.target.value.trim() === '' ? undefined : Number(e.target.value),
                        },
                      })}
                    />
                  </label>
                ))}
              </div>
              <p style={HINT_TEXT}>
                范围模式靠这几个值把请求尺寸夹到上游接受的区间里。一个都不填，这条契约保存成功但什么都不约束：
                原样把用户要的尺寸发给上游，被拒的时候看不出是这里没配。至少填一项。
              </p>
            </>
          ) : null}

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {/*
              启用开关必须在这儿。列表里会把停用的契约标出来、接口也来回带着 enabled，
              唯独表单没有这个控件——于是一条从接口建出来的停用契约在控制台永远开不回来，
              而一条在跑的契约想暂停只能删掉重建（形状 2：链路只建了一半，另一半在界面上缺着）。
              默认值判的是「不等于 false」而不是 Boolean(...)：字段缺失的存量契约是启用的。
            */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                id="imagegen-enabled"
                type="checkbox"
                checked={editing.draft.enabled !== false}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, enabled: e.target.checked } })}
              />
              <span>启用这条契约</span>
            </label>
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
