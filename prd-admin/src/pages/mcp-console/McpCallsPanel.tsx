import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, ExternalLink } from 'lucide-react';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { authorizeMcpCall } from '@/services/real/mcpConsole';
import { toast } from '@/lib/toast';
import { listMcpCalls } from '@/services';
import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';
import { safeArtifactHref } from './artifactHref';
import { eventTime, groupCalls, outcomeOf, soloGroup, type CallGroup } from './callGroups';
import { eventClock } from './eventClock';

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  success: {
    label: '成功',
    color: 'var(--semantic-success-text)',
    bg: 'var(--semantic-success-soft)',
    border: 'var(--semantic-success-border)',
  },
  denied: {
    label: '被挡下',
    color: 'var(--semantic-warning-text)',
    bg: 'var(--semantic-orange-soft)',
    border: 'var(--semantic-orange-border)',
  },
  error: {
    label: '失败',
    color: 'var(--semantic-danger-text)',
    bg: 'var(--semantic-danger-soft)',
    border: 'var(--semantic-danger-border)',
  },
  // 「问到了」不等于「跑完了」：以查看收尾又没有产物的多步事件落在这里。
  // 不猜成功也不猜失败 —— 给一个失败的 run 打绿色「成功」比不说话糟得多。
  pending: {
    label: '还没出结果',
    color: 'var(--text-muted)',
    bg: 'var(--semantic-neutral-soft)',
    border: 'var(--semantic-neutral-border)',
  },
};

/**
 * 出了事之后该往哪走。按 status 给，不去猜错误文案里写了什么 ——
 * 拿字符串片段去认原因，换一句措辞就静默失效，而这块面板是排障用的。
 */
const NEXT_STEP: Record<string, string> = {
  denied:
    '它没这块权限，或者今天的额度用完了。在「客户端」中点击对应的「管理」，检查授权范围和每日额度。',
  error: '请根据错误原因检查参数或服务状态；重试写入前先确认是否已产生结果。',
};

function statusStyle(status: string, artifact: McpCallLogDto['artifact']) {
  if (status === 'error' && artifact?.kind === 'audio-run' && artifact.status === 'unknown')
    return { ...STATUS_STYLE.denied, label: '待核查' };
  return STATUS_STYLE[status] ?? STATUS_STYLE.success;
}

/**
 * 「它干了什么」—— 一件事一行。
 *
 * 流水本身是每次工具调用一行，而一次生图 = 1 次入队 + N 次轮询：长得一模一样的 N+1 行，
 * 把「那张图到底出来没有」淹在自己的噪音里。所以这里按产物身份折成事件（见 callGroups.ts），
 * 中间那些轮询折进去，想看的人点开。
 *
 * 失败那一行整行染色 + 一句人话 + 一句下一步 —— 只写「失败」等于把排障丢回给用户。
 */
export function McpCallsPanel({
  clients,
  refreshToken = 0,
  initialStatus = '',
  initialKeyId = '',
  onAuthorized,
  compact = false,
  onViewAll,
}: {
  clients: McpClientDto[];
  /** 页面顶部「刷新」每点一次加一。记录列表自己拉自己的数据，不进依赖就永远是旧的。 */
  refreshToken?: number;
  initialStatus?: string;
  initialKeyId?: string;
  onAuthorized?: () => void;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [items, setItems] = useState<McpCallLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [keyId, setKeyId] = useState<string>(initialKeyId);
  const [status, setStatus] = useState<string>(initialStatus);
  const [skip, setSkip] = useState(0);
  const limit = compact ? 5 : 50;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 读失败要留一个**持续存在**的错误态。只弹一下 toast 的话，界面会退到两种更糟的样子：
  // 首次加载显示「还没有调用记录」（把「没读到」说成「你还没用过」），
  // 换筛选条件失败则把上一次的行留在新条件下面（把别的客户端的记录说成这个客户端的）。
  // 审计面板一旦开始说谎，用户还不如没有它。
  const [loadError, setLoadError] = useState<string | null>(null);

  // 筛选条件连改两次时会有两个 load 同时在飞，谁后回来谁覆盖 items —— 慢的那个是旧条件的结果，
  // 于是当前筛选下会显示别的客户端/别的结果状态的记录。给每次请求发一个代次号，
  // 回来时不是最新那次就整段丢弃（错误态同理，否则旧请求的失败会盖掉新请求的成功）。
  const loadGenRef = useRef(0);

  // 选中的客户端被吊销/删除之后，它不再出现在 clients 里，而 keyId 还留着 ——
  // 受控 <select> 找不到对应 option 时浏览器会显示第一项「全部客户端」，
  // 请求却还带着那个 keyId：**看到的筛选条件和实际在筛的不是一回事**，
  // 而这块面板是审计用的，它一旦开始说谎就不如没有。所以跟着 clients 收回来。
  useEffect(() => {
    if (keyId && !clients.some((c) => c.keyId === keyId)) { setKeyId(''); setSkip(0); }
  }, [clients, keyId]);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setExpandedId(null);
    try {
      const res = await listMcpCalls({ keyId: keyId || undefined, status: status || undefined, skip, limit });
      if (gen !== loadGenRef.current) return;
      if (!res.success || !res.data) throw new Error(res.error?.message || '服务暂时不可用，请稍后重试。');
      setLoadError(null);
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (error) {
      if (gen !== loadGenRef.current) return;
      setLoadError(error instanceof Error ? error.message : '连接中断，请稍后重试。');
      setItems([]);
      setTotal(0);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [keyId, status, skip, limit]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // 按结果筛选时**不折**：筛「失败」的人要的是每一条失败，把中途成功的轮询折进来
  // 会让这一屏显示出一条「成功」的事件 —— 与他选的筛选条件正相反。
  //
  // 筛完还要再按**结局**过一道：服务端那个 status 过的是 log.Status，也就是纯 HTTP 结果，
  // 而排队中的生图 run 回的正是 200。不过这一道，选「成功」会看到一行写着「还没出结果」，
  // 跟刚选的条件当场打架。这里丢掉的那些不会消失 —— 它们在「全部结果」里照常看得到。
  const groups = useMemo(() => {
    if (!status) return groupCalls(items);
    return items.map(soloGroup).filter((g) => g.status === status).sort((a, b) => Date.parse(eventTime(b)) - Date.parse(eventTime(a)));
  }, [items, status]);

  // 服务端按纯 HTTP 结果分页取 50 条，这一道语义过滤发生在**取完之后**。
  // 极端情况下最新 50 条「HTTP 成功」全是排队中的轮询，选「成功」就会得到一个空列表 ——
  // 而更早确实有成功过的记录，这一屏却一个字都不说，看起来像功能坏了。
  // 不去改成「一直取到凑够 N 条」：那要么把分页语义搬到前端，要么让服务端认识业务状态，
  // 都是新的语义类别。这里只保证**不沉默**：把被滤掉的条数如实说出来，并指到看得见它们的地方。
  const filteredOut = status ? items.length - groups.length : 0;

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${compact ? '' : 'flex-1'}`}>
      {compact && <div className="mcp-section-heading"><h2>最近请求 <span>最近 5 次工具调用</span></h2><button onClick={onViewAll}>全部记录</button></div>}
      <p className="mcp-history-scope">最新在前 · 本地时间 · 当前环境 · 当前账号 · 全部日期。仅记录工具调用；初始化、工具列表查询和其他接口请求不计入。</p>
      {/* 筛选 */}
      {!compact && <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="筛选调用客户端"
          value={keyId}
          onChange={(e) => { setKeyId(e.target.value); setSkip(0); }}
          className="h-8 rounded-[9px] px-2.5 text-[12px]"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <option value="">全部客户端</option>
          {clients.map((c) => (
            <option key={c.keyId} value={c.keyId}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选调用结果"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setSkip(0); }}
          className="h-8 rounded-[9px] px-2.5 text-[12px]"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="denied">被挡下</option>
          <option value="error">失败</option>
        </select>
        <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {loading ? '正在读取记录…' : loadError ? '记录暂不可用' : status
            ? `共 ${total} 次调用，这一档里最近 ${groups.length} 条${
                filteredOut > 0 ? `（另有 ${filteredOut} 条按任务当前状态不属于这一档，可在「全部结果」里查看）` : ''
              }`
            : `最近 ${items.length} 次调用折成 ${groups.length} 件事（共 ${total} 次）`}
        </span>
      </div>}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <PrdLoader size={36} />
        </div>
      ) : loadError ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[14px] p-8 text-center"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--semantic-warning-border)' }}
        >
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            调用记录没读到
          </p>
          <p className="max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {loadError}
            <br />
            此次未能取得日志，无法判断是否有调用记录。
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
          >
            重试
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[14px] p-8 text-center"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          {/* 「一条都没有」和「这一档筛没了」是两件事。上一版共用同一段引导语，于是
              正上方的计数行刚说「另有 N 条被滤掉」，这里就说「还没有调用记录，去接一台客户端」
              —— 同一屏自己打架，而且把一个筛选结果说成了空历史。 */}
          {keyId || status || skip > 0 || filteredOut > 0 ? (
            <>
              <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                当前筛选下没有记录
              </p>
              <p className="max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {filteredOut > 0
                  ? `最近这一页里有 ${filteredOut} 条按传输结果算成功、但产物还没出来，它们不算在这一档里。把上面的筛选切回「全部结果」就能看到。`
                  : '当前客户端或结果条件下没有匹配记录，可以清除筛选查看全部历史。'}
              </p>
              <button className="mcp-button" onClick={() => { setKeyId(''); setStatus(''); setSkip(0); }}>清除筛选</button>
            </>
          ) : (
            <>
              <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                当前环境暂无工具调用记录
              </p>
              <p className="max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                已成功读取日志，但当前账号在本环境下尚无记录。请确认客户端连接的是本页的连接地址，并实际调用一项工具；仅连接或查询工具列表不会产生这里的记录。
              </p>
            </>
          )}
        </div>
      ) : (
        <div className={`flex min-h-0 flex-col gap-2 pr-0.5 ${compact ? '' : 'flex-1 overflow-auto'}`}>
          {groups.map((group) => (
            <EventRow
              key={group.id}
              group={group}
              compact={compact}
              onAuthorized={() => { void load(); onAuthorized?.(); }}
              expanded={expandedId === group.id}
              onToggle={() => setExpandedId(expandedId === group.id ? null : group.id)}
            />
          ))}
        </div>
      )}
      {!compact && !loadError && (total > limit || skip > 0) && <div className="mcp-history-pagination"><button className="mcp-button" disabled={loading || skip === 0} onClick={() => setSkip(value => Math.max(0, value - limit))}>上一页</button><span>第 {Math.floor(skip / limit) + 1} 页 · 共 {total} 次工具调用</span><button className="mcp-button" disabled={loading || skip + limit >= total} onClick={() => setSkip(value => value + limit)}>下一页</button></div>}
    </div>
  );
}

function EventRow({
  group,
  compact = false,
  onAuthorized,
  expanded,
  onToggle,
}: {
  group: CallGroup;
  onAuthorized?: () => void;
  compact?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const st = statusStyle(group.status, group.artifact);
  const audioRun = group.artifact?.kind === 'audio-run';
  const uncertainAudio = group.status === 'error' && audioRun && group.artifact?.status === 'unknown';
  // pending 不是失败：不整行染色、也不给「下一步」（没什么要他做的，等就完了）
  const bad = group.status === 'error' || group.status === 'denied';
  const href = safeArtifactHref(group.artifact?.url);
  const title = group.first.toolName;
  const nextStep = group.last.authorizationScope
    ? '点击「授权」补充该工具所需权限，然后在客户端重新发起调用。'
    : uncertainAudio ? '请打开语音任务历史核查上游结果，确认前不要再次提交生成，避免重复计费。' : NEXT_STEP[group.status];

  return (
    <div
      className={`mcp-event ${compact ? 'mcp-event-compact' : ''}`}
      data-call-id={group.first.id}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* 展开钮与「打开」是**兄弟**，不是父子。
          原来「打开」那个 <a> 长在这个 <button> 里 —— 嵌套交互控件的无障碍树是无效的：
          读屏用户会把链接当成展开钮的一部分，键盘 Tab 到的东西也说不准。
          布局仍是一行：button 吃掉剩余宽度，链接贴右。 */}
      <div className="mcp-event-header">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mcp-event-row"
      >
        <ChevronRight size={14} className={expanded ? 'mcp-event-chevron rotate-90' : 'mcp-event-chevron'} aria-hidden />
        <time className="mcp-event-time" dateTime={eventTime(group)} title={new Date(eventTime(group)).toLocaleString('zh-CN')}>
          {eventClock(eventTime(group))}
        </time>
        <span className="mcp-event-client" title={group.first.keyName}>{group.first.keyName}</span>
        <span className="mcp-event-tool" title={title}>{title}{group.artifact?.title && <small>{group.artifact.title}</small>}</span>
        <span className="mcp-event-kind">{group.multiStep ? `${group.steps.length} 步` : group.imageCount > 0 ? `${group.imageCount} 张图` : group.isWrite ? '写入' : '读取'}</span>
        <span className="mcp-event-duration">{group.elapsedMs > 0 && group.elapsedMs < 1000 ? `${Math.round(group.elapsedMs)}ms` : group.elapsedMs >= 1000 ? `${(group.elapsedMs / 1000).toFixed(1)}s` : '—'}</span>
        <span className="mcp-event-status" style={{ background: st.bg, border: `1px solid ${st.border}`, color: st.color }}>{st.label}</span>
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 py-2.5 pr-3.5 text-[11.5px] font-medium"
          style={{ color: 'var(--accent-primary)' }}
        >
          <ExternalLink size={12} aria-hidden />
          {audioRun ? '查看语音任务' : '打开'}
        </a>
      )}
      </div>

      {/* 统一行高；状态始终可见，原因与参数在展开区展示。 */}
      {bad && expanded && (
        <div className="flex flex-col gap-1 px-3.5 pb-2.5" style={{ paddingLeft: 46 }}>
          <span className="flex items-start gap-1.5 text-[12px] leading-relaxed" style={{ color: st.color }}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            {group.last.errorMessage || (uncertainAudio ? '上游结果尚未确认，需要核查任务。' : audioRun ? '语音生成失败，请打开任务历史查看原因。' : '服务端没有留下可读的原因。')}
            {group.last.authorizationScope && <button className="mcp-authorize" disabled={granting} title={`为此 Key 增加 ${group.last.authorizationScope}`} onClick={async () => {
              setGranting(true); setGrantError(null);
              try {
                const result = await authorizeMcpCall(group.last.id);
                if (!result.success) throw new Error(result.error?.message || '授权失败');
                toast.success('已授权，可在客户端重新发起调用'); onAuthorized?.();
              } catch (error) { setGrantError(error instanceof Error ? error.message : '授权失败，请重试'); }
              finally { setGranting(false); }
            }}>{granting ? '授权中…' : '授权'}</button>}

          </span>
          {grantError && <span role="alert" className="text-[11px]">{grantError}</span>}
          {nextStep && (
            <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {nextStep}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div
          className="flex flex-col gap-2.5 rounded-b-[11px] px-3.5 py-3"
          style={{ background: 'var(--bg-sunken)', borderTop: '1px solid var(--border-faint)' }}
        >
          <DetailRow label="工具" value={group.first.toolName} mono />
          <DetailRow label="记录编号" value={group.first.id} mono />
          <DetailRow label="它发过来的参数" value={group.first.argumentsPreview || '（无参数）'} mono />
          {group.artifact?.url && <DetailRow label={audioRun ? '任务历史' : '产物地址'} value={group.artifact.url} mono />}
          {/* 没有可点地址时至少把 id 露出来（如还没跑完的生图 run）：
              既没有「打开」又看不到 id，这条记录就等于只告诉用户「有个东西」。 */}
          {!group.artifact?.url && group.artifact?.id && (
            <DetailRow label="产物" value={`${group.artifact.kind ?? '产物'} · ${group.artifact.id}`} mono />
          )}

          {group.multiStep && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                {group.hasOrigin
                  ? `这件事分了 ${group.steps.length} 步（新到旧）`
                  : `这一页里看到它的 ${group.steps.length} 次（新到旧）；发起那一次在更早的记录里`}
              </span>
              {group.steps.map((step) => {
                const sst = statusStyle(outcomeOf(step, step.artifact ?? null), step.artifact);
                return (
                  <div
                    key={step.id}
                    className="flex flex-wrap items-baseline gap-2 rounded-[8px] px-2.5 py-1.5"
                    style={{ background: 'var(--bg-nested)' }}
                  >
                    <span className="w-[46px] shrink-0 text-[10.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {eventClock(step.createdAt)}
                    </span>
                    <code
                      className="text-[11px]"
                      style={{
                        color: 'var(--text-secondary)',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      }}
                    >
                      {step.toolName}
                    </code>
                    <span className="text-[10.5px]" style={{ color: sst.color }}>
                      {sst.label}
                    </span>
                    <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {step.durationMs > 0 ? `${(step.durationMs / 1000).toFixed(1)}s` : ''}
                    </span>
                    {/* 这一行的动作分类照实写（这次要干的确实是写入/出图），额度没动的事实由这个标记说出来。
                        不这么分开的话，只能把分类抹成「只读动作·0 张图」——记录就跟它实际干的事不符了。 */}
                    {step.deduplicated && (
                      <span className="text-[10.5px]" style={{ color: 'var(--semantic-info-text)' }}>
                        幂等命中 · 未计额度
                      </span>
                    )}
                    {step.errorMessage && (
                      <span className="text-[10.5px]" style={{ color: sst.color }}>
                        {step.errorMessage}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {/* 不显示原始 HTTP 状态码：这是给普通用户（access 权限）看的页面，不是管理员诊断面。
                结果本身上面那枚状态徽章已经说了（成功 / 被挡下 / 失败），失败原因由 errorMessage
                用人话给出；状态码只对排障有意义，它留在服务端的 mcp_call_logs 里。 */}
            <span>{group.isWrite ? '写入类动作' : '只读动作'}</span>
            {group.imageCount > 0 && <span>{group.imageCount} 张图</span>}
            {!group.multiStep ? (
              <span>耗时 {(group.elapsedMs / 1000).toFixed(1)}s</span>
            ) : group.hasOrigin ? (
              // 「落地」是「产物真的出来了」的意思，只有真成了才配这么说。
              // 原来这里只看 multiStep + hasOrigin，于是一个还在排队的 run 也被写成
              // 「从发起到落地 Xs」——上面那枚徽章明明标着「还没出结果」，同一行自己打架。
              group.status === 'pending' ? (
                <span>从发起算起 {(group.elapsedMs / 1000).toFixed(1)}s，还没出结果</span>
              ) : group.status === 'success' ? (
                <span>从发起到落地 {(group.elapsedMs / 1000).toFixed(1)}s</span>
              ) : uncertainAudio ? (
                <span>从发起到最近查询 {(group.elapsedMs / 1000).toFixed(1)}s，结果待核查</span>
              ) : (
                <span>从发起到失败 {(group.elapsedMs / 1000).toFixed(1)}s</span>
              )
            ) : (
              // 发起那一次不在这一页里 —— 只能说「看到的这几次跨了多久」，不能说成从发起算起
              <span>这一页里看到的 {group.steps.length} 次跨 {(group.elapsedMs / 1000).toFixed(1)}s</span>
            )}
            <span>{group.multiStep ? '发起于 ' : ''}{new Date(group.first.createdAt).toLocaleString('zh-CN')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className="break-all text-[11.5px] leading-relaxed"
        style={{
          color: 'var(--text-secondary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
