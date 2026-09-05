import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  RotateCcw,
  Settings2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { createAgentApiKey, getMcpVisibleTools } from '@/services';
import type { McpCapabilityDto, McpVisibleToolsDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { copyToClipboard } from './clipboard';
import { capabilityVisual } from './capabilityRegistry';
import { autoPicks, picksToScopes, samePicks, type CapabilityPicks } from './scopePlan';

/** 只有两屏：填名字 / 拿配置。中间那道「选能力」被收进高级设置了。 */
type Step = 'form' | 'connect';

type ClientKind = 'claude-code' | 'claude-desktop' | 'codex';

/**
 * 授权自检的等待上限。
 *
 * 它是可选的加分项，不该有能力扣住那把已经生效的钥匙。超时后只是「没跑完」，
 * 钥匙照旧可见可复制 —— 判据是「用户手里有没有那串明文」，不是「自检有没有结论」。
 */
const SelfCheckTimeoutMs = 15_000;

/** 给一个不带超时的请求套上上限。超时返回 null，底下那条请求随它跑完，结果不再采用。 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    task,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}

/**
 * 接入弹窗 —— 起个名字，一键复制配置，完事。
 *
 * 上一版是三步向导：先让用户逐块勾能力，再出钥匙，再给配置。用户的原话是「步骤有点多，
 * 其实选择什么，客户是没有选择能力的」—— 让一个人对着五张卡片决定要不要把「网页托管的写入档」
 * 交出去，是把系统本来就该知道的事推给他判断（minimal-user-input）。
 *
 * 所以主路径上不放选择，只放**告知**：默认就是「你自己有的全部能力」，
 * 想改的人点开「高级设置」。这两档在服务端是两种语义，不只是界面折叠：
 *   - 没动过高级设置 → 自动档，钥匙不存清单，平台以后新上一块能力它自动就有；
 *   - 动过 → 手动档，按当时那份清单钉死，平台新增的不会自动进来（面板会告诉用户「你还能给它什么」）。
 *
 * 收不回来的动作（删除、公开发布）一律不给，两档都一样，高级设置里也调不出来。
 */
export function ConnectAgentDialog({
  open,
  onOpenChange,
  capabilities,
  endpointUrl,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capabilities: McpCapabilityDto[];
  endpointUrl: string;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<Step>('form');
  const [clientName, setClientName] = useState('我的 Claude Code');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState('');
  const [visible, setVisible] = useState<McpVisibleToolsDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkTimedOut, setCheckTimedOut] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // 留着密钥 id 才能重试自检。明文不能重来，自检可以。
  const [issuedKeyId, setIssuedKeyId] = useState<string | null>(null);
  const [configTab, setConfigTab] = useState<ClientKind>('claude-code');

  const defaults = useMemo(() => autoPicks(capabilities), [capabilities]);
  const [picks, setPicks] = useState<CapabilityPicks>(defaults);
  // 「用户碰过高级设置没有」是一个独立的事实，不能从 picks 与 defaults 的差异反推：
  // 能力目录是异步拉回来的，弹窗先挂载时 defaults 还是空的，之后一变，
  // 「没碰过但两者不相等」这个中间态就会被读成「碰过」，跟着 picks 就再也不更新了 ——
  // 高级设置一打开显示「一块都没开」，而实际提交的是自动档（全给）。
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setPicks(defaults);
  }, [defaults, dirty]);

  const changePicks = useCallback((next: CapabilityPicks) => {
    setDirty(true);
    setPicks(next);
  }, []);

  /**
   * 用户动过高级设置就钉死；没动过（或改回默认了）就跟着他的权限走。
   * 判据是「这份清单跟默认档一不一样」，不是「他有没有点开过面板」——
   * 点开看一眼又原样关掉的人，不该因此失去「平台新增能力自动进来」。
   */
  const scopeMode: 'auto' | 'manual' = samePicks(picks, defaults) ? 'auto' : 'manual';
  const scopes = useMemo(() => picksToScopes(capabilities, picks), [capabilities, picks]);

  const reset = useCallback(() => {
    setStep('form');
    setClientName('我的 Claude Code');
    setAdvancedOpen(false);
    setPicks(defaults);
    setDirty(false);
    setPlaintext('');
    setVisible(null);
    setChecking(false);
    setCheckTimedOut(false);
    setCheckError(null);
    setIssuedKeyId(null);
    // 关闭/重置即作废在途自检：它的回应回来时号已经对不上，不会再往界面上写
    checkGenRef.current += 1;
  }, [defaults]);

  // 自检是后台跑的，而弹窗随时可能被关掉、重开、再签一把新钥匙。没有代次的话，
  // 上一把钥匙的回应可以在关闭后落地（显示成新钥匙的工具清单），或者晚到一步把新自检的
  // 结果盖掉 —— 用户看到的是**别的钥匙**能调什么。所以每次自检领一个号，回来先验号。
  const checkGenRef = useRef(0);

  const runSelfCheck = useCallback(async (keyId: string) => {
    const gen = ++checkGenRef.current;
    setChecking(true);
    setCheckTimedOut(false);
    setCheckError(null);
    const check = await withTimeout(getMcpVisibleTools(keyId), SelfCheckTimeoutMs);
    if (gen !== checkGenRef.current) return;   // 号过期：期间关过弹窗或又发了一把钥匙
    if (check === null) setCheckTimedOut(true);
    else if (check.success && check.data) setVisible(check.data);
    // 超时之外的失败（401 / 500 / 网络断）原来什么都不设：转圈直接消失，
    // 既没有结果也没有说法，更没有重试 —— 而这把钥匙的明文只出现这一次。
    else setCheckError(check.error?.message || '自检没能完成，钥匙已经发出来了，可以先复制保存。');
    setChecking(false);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      // 签发在途时不许关。密钥明文只在这一次响应里出现，关掉就 reset 掉了 ——
      // 而后台那把钥匙已经建出来了，用户手里多一把自己看不到、也找不回来的钥匙。
      if (!next && creating) return;
      onOpenChange(next);
      if (!next) reset();
    },
    [onOpenChange, reset, creating],
  );

  const createKey = useCallback(async () => {
    // 自动档不提交清单（服务端不存），所以「一个都没勾」只可能出现在手动档。
    if (scopeMode === 'manual' && scopes.length === 0) {
      toast.error('至少留一块能力', '一块都不留的话，它连上来什么也做不了');
      return;
    }
    setCreating(true);
    const res = await createAgentApiKey({
      name: clientName.trim() || '未命名客户端',
      scopes,
      ttlDays: 90,
      scopeMode,
    });
    if (!res.success || !res.data) {
      setCreating(false);
      toast.error('密钥创建失败', res.error?.message);
      return;
    }
    // 钥匙已经在服务端生效，而明文只在这一次响应里出现 —— 先把它交到用户手上，再做别的。
    // 上一版把自检 await 在这中间（为的是不让用户连点两次签出两把钥匙），代价是：
    // 自检那条请求没有超时，一旦挂住，用户既看不到已经生效的钥匙、也关不掉弹窗
    // （关闭在签发期间被锁着），刷新一次那串明文就永久没了。
    // 连点的洞用另一种方式堵：跟着切到「接上」那一步，签发按钮随上一步一起卸载，
    // 压根不存在第二次可点 —— 两个性质同时成立，不用二选一。
    setPlaintext(res.data.apiKey);
    setStep('connect');
    setCreating(false);
    onCreated();

    const keyId = res.data.item?.id;
    if (!keyId) return;
    setIssuedKeyId(keyId);
    await runSelfCheck(keyId);
  }, [clientName, scopes, scopeMode, onCreated, runSelfCheck]);

  const configSnippet = useMemo(() => {
    const key = plaintext || 'sk-ak-你的密钥';
    if (configTab === 'claude-code') {
      return `claude mcp add --transport http map \\\n  ${endpointUrl} \\\n  --header "Authorization: Bearer ${key}"`;
    }
    if (configTab === 'claude-desktop') {
      return JSON.stringify(
        {
          mcpServers: {
            map: { type: 'http', url: endpointUrl, headers: { Authorization: `Bearer ${key}` } },
          },
        },
        null,
        2,
      );
    }
    // Codex 的键是 http_headers（map<string,string>），不是嵌套的 [mcp_servers.map.headers] 表 ——
    // 写成嵌套表 TOML 照样解析得过，但 Codex 认不出来，鉴权头被静默丢掉，
    // 请求会以匿名身份打到需要密钥的 MCP 端点。见 Codex 配置参考 mcp_servers.<id>.http_headers。
    return `[mcp_servers.map]\nurl = "${endpointUrl}"\nhttp_headers = { Authorization = "Bearer ${key}" }`;
  }, [configTab, endpointUrl, plaintext]);

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      title="接入你的智能体"
      description="复制一段配置粘进 Claude Code、Codex，它就能替你生图、写稿、整理知识库、把网页托管出来"
      maxWidth={560}
      content={
        <div className="flex flex-col gap-4">
          {step === 'form' && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  给它起个名字
                </span>
                <input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="h-[38px] rounded-[10px] px-3 text-[13.5px]"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                />
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  随便起 —— 以后想断开它，按这个名字找。
                </span>
              </label>

              <ScopeDisclosure
                capabilities={capabilities}
                picks={picks}
                scopeMode={scopeMode}
                open={advancedOpen}
                onToggleOpen={() => setAdvancedOpen((v) => !v)}
                onChange={changePicks}
                onRestoreDefaults={() => {
                  setDirty(false);
                  setPicks(defaults);
                }}
              />
            </>
          )}

          {step === 'connect' && (
            <div className="flex flex-col gap-3">
              <div
                className="flex items-center gap-3 rounded-[12px] px-3.5 py-3"
                style={{
                  background: 'var(--semantic-orange-soft)',
                  border: '1px solid var(--semantic-orange-border)',
                }}
              >
                <KeyRound size={17} style={{ color: 'var(--accent-primary)' }} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[12px] font-semibold" style={{ color: 'var(--semantic-warning-text)' }}>
                    这把钥匙只显示这一次
                  </span>
                  <code
                    className="truncate text-[12px]"
                    style={{
                      color: 'var(--text-primary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    }}
                  >
                    {plaintext}
                  </code>
                </div>
                <CopyButton text={plaintext} label="复制" />
              </div>

              <div className="flex gap-1 rounded-[11px] p-1" style={{ background: 'var(--tab-container-bg)' }}>
                {([
                  { key: 'claude-code' as const, label: 'Claude Code' },
                  { key: 'claude-desktop' as const, label: 'Claude 桌面' },
                  { key: 'codex' as const, label: 'Codex' },
                ]).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setConfigTab(t.key)}
                    className="flex-1 rounded-[9px] py-1.5 text-[12.5px] font-medium"
                    style={
                      configTab === t.key
                        ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                        : { background: 'transparent', color: 'var(--text-muted)' }
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {configTab === 'claude-code' ? '在终端里跑这一行' : '粘进配置文件'}
                </span>
                <pre
                  className="overflow-x-auto rounded-[11px] px-3.5 py-3 text-[11.5px] leading-relaxed"
                  style={{
                    background: 'var(--tab-container-bg)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  }}
                >
                  {configSnippet}
                </pre>
              </div>

              {checking && (
                <div
                  className="flex items-center gap-2 rounded-[12px] px-3.5 py-3"
                  style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-faint)' }}
                >
                  <span
                    className="block h-1.5 w-1.5 animate-pulse rounded-full"
                    style={{ background: 'var(--accent-primary)' }}
                  />
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    正在核对这把钥匙能看到哪些工具…（钥匙已经生效，先复制上面那串就行）
                  </span>
                </div>
              )}

              {(checkTimedOut || checkError) && (
                <div
                  className="rounded-[12px] px-3.5 py-3 text-[12px] leading-relaxed"
                  style={{
                    background: 'var(--semantic-warning-soft)',
                    border: '1px solid var(--semantic-warning-border)',
                    color: 'var(--semantic-warning-text)',
                  }}
                >
                  <div>
                    {checkTimedOut
                      ? '授权自检这次没跑完（超过 15 秒没有回应）。'
                      : `授权自检没能完成：${checkError}`}
                    这不影响上面那把钥匙 —— 它已经生效，复制走就能用。自检只是替你先核一遍授权对不对。
                  </div>
                  {issuedKeyId && (
                    <button
                      type="button"
                      onClick={() => void runSelfCheck(issuedKeyId)}
                      className="mt-2 rounded-[7px] px-2.5 py-1 text-[12px] font-medium"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
                    >
                      重试自检
                    </button>
                  )}
                </div>
              )}

              {visible && (
                <div
                  className="flex flex-col gap-2 rounded-[12px] px-3.5 py-3"
                  style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-faint)' }}
                >
                  {/* 钥匙用不了的时候不能报「自检通过」：/api/mcp 那边会直接拒，
                      一个工具都调不动，报通过等于把用户送去撞墙。宽限期也照实说，
                      不然某天突然全部调不动、找不着原因。 */}
                  <div className="flex items-center gap-2">
                    {visible.isActive ? (
                      <Check size={15} style={{ color: 'var(--semantic-success-text)' }} aria-hidden />
                    ) : (
                      <ShieldAlert size={15} style={{ color: 'var(--semantic-danger-text)' }} aria-hidden />
                    )}
                    <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {visible.isActive
                        ? `授权自检通过：这把钥匙能看到 ${visible.toolCount} 个工具`
                        : '这把钥匙现在用不了，接上去一个工具也调不动'}
                    </span>
                  </div>
                  {visible.unusableReason && (
                    <div
                      className="text-[11.5px] leading-relaxed"
                      style={{ color: visible.isActive ? 'var(--semantic-warning-text)' : 'var(--semantic-danger-text)' }}
                    >
                      {visible.unusableReason}
                      {visible.isActive ? '。到「连着的客户端」里续期即可。' : '。请另建一把新钥匙。'}
                    </div>
                  )}
                  <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    这一步核的是授权对不对（服务端按 scope 算的），不代表你的客户端已经连通 —— 那要等你把上面的配置粘过去。
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 底部动作 */}
          <div className="flex items-center gap-2.5 pt-0.5">
            {step === 'form' && (
              <button
                type="button"
                disabled={creating}
                onClick={() => void createKey()}
                className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[11px] text-[13.5px] font-semibold disabled:opacity-60"
                style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
              >
                {creating ? '正在生成…' : '生成接入配置'}
              </button>
            )}
            {step === 'connect' && (
              <>
                <CopyPrimaryButton text={configSnippet} />
                <button
                  type="button"
                  onClick={() => handleClose(false)}
                  className="h-10 rounded-[11px] px-4 text-[13px] font-medium"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  完成
                </button>
              </>
            )}
          </div>

          <p className="text-center text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {step === 'form'
              ? '有效期 90 天，到期前可在下方客户端列表里续期；明文只显示一次。'
              : '粘完重启客户端，跟它说一句「把这周周报做成一页网页发出来」就能用。'}
          </p>
        </div>
      }
    />
  );
}

/**
 * 「默认给什么」那一块：先告知，再给一个可以改的入口。
 *
 * 折叠态是**说明**（无边框标签），展开态才是**选择**（有开关）。上一版把两者画成
 * 一排大小不一的按钮，读者分不清哪个能点 —— 说明和动作要在视觉上分开。
 */
function ScopeDisclosure({
  capabilities,
  picks,
  scopeMode,
  open,
  onToggleOpen,
  onChange,
  onRestoreDefaults,
}: {
  capabilities: McpCapabilityDto[];
  picks: CapabilityPicks;
  scopeMode: 'auto' | 'manual';
  open: boolean;
  onToggleOpen: () => void;
  onChange: (next: CapabilityPicks) => void;
  onRestoreDefaults: () => void;
}) {
  const granted = capabilities.filter((cap) => picks[cap.key]?.read || picks[cap.key]?.write);
  const blocked = capabilities.filter((cap) => !cap.availableToMe);

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[12px] px-3.5 py-3"
      style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {scopeMode === 'auto' ? '默认把你有的能力都给它' : '按你选的这几块给它'}
        </span>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="flex h-7 items-center gap-1.5 rounded-[8px] pl-2.5 pr-2 text-[12px] font-medium"
          style={{
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <Settings2 size={13} aria-hidden />
          高级设置
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        </button>
      </div>

      {/* 折叠态：只告知它能做什么、以及什么永远不给 */}
      {!open && (
        <div className="flex flex-wrap gap-1.5">
          {granted.map((cap) => {
            const v = capabilityVisual(cap.key);
            const pick = picks[cap.key];
            const Icon = v.icon;
            return (
              <span
                key={cap.key}
                className="flex h-[23px] items-center gap-1.5 rounded-full px-2.5 text-[11px]"
                style={{ background: v.soft, border: `1px solid ${v.border}`, color: v.text }}
              >
                <Icon size={11} aria-hidden />
                {cap.title}
                {pick?.write && cap.readScope ? ' · 读写' : ''}
              </span>
            );
          })}
          <span
            className="flex h-[23px] items-center gap-1.5 rounded-full px-2.5 text-[11px]"
            style={{
              background: 'var(--semantic-neutral-soft)',
              border: '1px solid var(--semantic-neutral-border)',
              color: 'var(--text-muted)',
            }}
          >
            <X size={11} aria-hidden />
            删除 · 公开发布
          </span>
        </div>
      )}

      {/* 展开态：这才是选择 */}
      {open && (
        <div className="flex flex-col gap-2">
          {capabilities.map((cap) => {
            const v = capabilityVisual(cap.key);
            const Icon = v.icon;
            const pick = picks[cap.key] ?? { read: false, write: false };
            const on = pick.read || pick.write;
            const disabled = !cap.availableToMe;
            // 只有写入档、没有只读档的能力：开了就是把写入交出去，卡片上必须写明白
            const writeOnly = !cap.readScope && !!cap.writeScope;
            if (disabled) return null;
            return (
              <div
                key={cap.key}
                className="flex flex-col gap-2 rounded-[11px] px-3 py-2.5"
                style={{
                  background: 'var(--bg-sunken)',
                  border: on ? `1px solid ${v.border}` : '1px solid var(--border-faint)',
                }}
              >
                <label className="flex cursor-pointer items-start gap-2.5">
                  <span
                    className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px]"
                    style={{ background: v.soft, border: `1px solid ${v.border}`, color: v.text }}
                  >
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {cap.title}
                    </span>
                    <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {cap.summary}
                    </span>
                    {writeOnly && on && (
                      <span className="text-[11px] leading-relaxed" style={{ color: 'var(--semantic-warning-text)' }}>
                        这块没有「只看」的档位：开着就是允许它生成内容、写进你的空间。
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={on}
                    onChange={(e) => {
                      const next = e.target.checked;
                      onChange({
                        ...picks,
                        [cap.key]: next
                          ? {
                              read: !!cap.readScope,
                              write: !!cap.writeScope && cap.writeAvailableToMe && (writeOnly || pick.write),
                            }
                          : { read: false, write: false },
                      });
                    }}
                  />
                </label>

                {/* 读写两档的能力才谈得上「能看 / 能写」；只有写入档的能力开着就是写 */}
                {on && cap.readScope && cap.writeScope && (
                  <div className="flex gap-1.5 pl-[36px]">
                    <span
                      className="flex h-[22px] items-center gap-1.5 rounded-[7px] px-2 text-[11px]"
                      style={{ background: v.soft, border: `1px solid ${v.border}`, color: v.text }}
                    >
                      <Check size={11} aria-hidden />
                      能看
                    </span>
                    <label
                      className={`flex h-[22px] items-center gap-1.5 rounded-[7px] px-2 text-[11px] ${cap.writeAvailableToMe ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                      style={
                        pick.write
                          ? { background: v.soft, border: `1px solid ${v.border}`, color: v.text }
                          : {
                              background: 'var(--semantic-neutral-soft)',
                              border: '1px solid var(--semantic-neutral-border)',
                              color: 'var(--text-muted)',
                            }
                      }
                    >
                      <input
                        type="checkbox"
                        className="h-[11px] w-[11px]"
                        disabled={!cap.writeAvailableToMe}
                        checked={pick.write}
                        onChange={(e) =>
                          onChange({ ...picks, [cap.key]: { read: true, write: e.target.checked } })
                        }
                      />
                      {cap.writeAvailableToMe ? '能写' : '能写（你自己还没这块权限）'}
                    </label>
                  </div>
                )}
              </div>
            );
          })}

          {blocked.map((cap) => (
            <div
              key={cap.key}
              className="flex items-center gap-2.5 rounded-[11px] px-3 py-2.5"
              style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-faint)', opacity: 0.6 }}
            >
              <ShieldAlert size={14} style={{ color: 'var(--semantic-warning-text)' }} aria-hidden />
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {cap.title}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  你自己还没有这块权限，得先找管理员开通
                </span>
              </span>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {scopeMode === 'auto'
                ? '现在跟着你的权限走：以后平台新上一块能力，它自动就有。'
                : '改过之后就按这份清单钉死：以后平台新上的能力不会自动进来，会在客户端那行提醒你。'}
            </span>
            {scopeMode === 'manual' && (
              <button
                type="button"
                onClick={onRestoreDefaults}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}
              >
                <RotateCcw size={12} aria-hidden />
                还原默认
              </button>
            )}
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        删除、公开发布这类收不回来的动作一律不给，高级设置里也调不出来。生图会花钱，每天有上限。
      </p>
    </div>
  );
}

function CopyPrimaryButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        setFailed(false);
        if (await copyToClipboard(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } else {
          setFailed(true);
          window.setTimeout(() => setFailed(false), 3200);
        }
      }}
      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[11px] text-[13.5px] font-semibold"
      style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
    >
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      {copied ? '已复制' : failed ? '复制失败，请手动选中' : '一键复制配置'}
    </button>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        // 必须等它真的写进去再报「已复制」。剪贴板 API 在非安全来源、无权限或被浏览器
        // 拒绝时会直接不存在或 reject —— 而这里复制的是**只显示一次**的密钥明文，
        // 报一句假的「已复制」，用户就会安心关掉弹窗，然后手里什么都没有。
        setFailed(false);
        if (await copyToClipboard(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } else {
          setFailed(true);
          window.setTimeout(() => setFailed(false), 3200);
        }
      }}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[11.5px] font-medium"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      {copied ? '已复制' : failed ? '复制失败，请手动选中' : label}
    </button>
  );
}
