import { useCallback, useMemo, useRef, useState } from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { createAgentApiKey, getMcpVisibleTools } from '@/services';
import type { McpCapabilityDto, McpVisibleToolsDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { copyToClipboard } from './clipboard';

type Step = 'capabilities' | 'key' | 'connect';

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
 * 三步接入向导：勾能力 → 出钥匙 → 接上。
 *
 * 两条硬规矩落在这里：
 *   - 默认只给「看」的权限，写入要单独再点一次（拍板结论）
 *   - 用户自己没有的权限位，卡片直接禁用并说明去找谁开通（服务端也会拒，这里只是先说清楚）
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
  const [step, setStep] = useState<Step>('capabilities');
  const [selected, setSelected] = useState<Record<string, { read: boolean; write: boolean }>>({});
  const [clientName, setClientName] = useState('我的 Claude Code');
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState('');
  const [visible, setVisible] = useState<McpVisibleToolsDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkTimedOut, setCheckTimedOut] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // 留着密钥 id 才能重试自检。明文不能重来，自检可以。
  const [issuedKeyId, setIssuedKeyId] = useState<string | null>(null);
  const [configTab, setConfigTab] = useState<'claude-code' | 'claude-desktop' | 'codex'>('claude-code');

  const scopes = useMemo(() => {
    const list: string[] = [];
    for (const cap of capabilities) {
      const pick = selected[cap.key];
      if (!pick) continue;
      if (pick.read && cap.readScope) list.push(cap.readScope);
      if (pick.write && cap.writeScope) list.push(cap.writeScope);
    }
    return Array.from(new Set(list));
  }, [capabilities, selected]);

  const reset = useCallback(() => {
    setStep('capabilities');
    setSelected({});
    setClientName('我的 Claude Code');
    setPlaintext('');
    setVisible(null);
    setChecking(false);
    setCheckTimedOut(false);
    setCheckError(null);
    setIssuedKeyId(null);
    // 关闭/重置即作废在途自检：它的回应回来时号已经对不上，不会再往界面上写
    checkGenRef.current += 1;
  }, []);

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
    if (scopes.length === 0) {
      toast.error('至少勾一块能力', '一个都不勾的话，智能体连上来什么也做不了');
      return;
    }
    setCreating(true);
    const res = await createAgentApiKey({ name: clientName.trim() || '未命名客户端', scopes, ttlDays: 90 });
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
  }, [clientName, scopes, onCreated, runSelfCheck]);

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
      title="连接新客户端"
      description="勾你愿意交出去的能力，剩下的这里替你配"
      maxWidth={720}
      content={
        <div className="flex flex-col gap-4">
          <StepBar step={step} />

          {step === 'capabilities' && (
            <div className="flex flex-col gap-2.5">
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                有只读档的能力，勾选只给「看」；要它动手写，得在卡片里单独再点一次。
                只有写入档的能力（视觉创作、文学创作）会在卡片上标出来 —— 勾上即授予写入。
              </p>
              {capabilities.map((cap) => {
                const pick = selected[cap.key] ?? { read: false, write: false };
                // 只有写入档、没有只读档的能力：勾选即授予写入，卡片上必须写明白
                const writeOnly = !cap.readScope && !!cap.writeScope;
                // 整张卡的可用性看「入口那一档」；写入单独看写入档 ——
                // 只有 web-pages.read 的人卡片能用，但写入勾选框必须是灰的，
                // 否则他勾完走到最后一步才被后端交集校验拒掉。
                const disabled = !cap.availableToMe;
                const writeDisabled = !cap.writeAvailableToMe;
                return (
                  <div
                    key={cap.key}
                    className="flex flex-col gap-2 rounded-[12px] px-3.5 py-3"
                    style={{
                      background: 'var(--bg-sunken)',
                      border: pick.read
                        ? '1.5px solid var(--accent-primary)'
                        : '1px solid var(--border-subtle)',
                      opacity: disabled ? 0.55 : 1,
                    }}
                  >
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={pick.read}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setSelected((prev) => ({
                            ...prev,
                            // 没有只读档的能力（视觉创作、文学创作），勾上就是把写入交出去 ——
                            // 这里直接落成 write，别用「读」的名义给出改动权限。
                            [cap.key]: writeOnly
                              ? { read: on, write: on }
                              : { read: on, write: on ? pick.write : false },
                          }));
                        }}
                        className="mt-0.5"
                      />
                      <span className="flex flex-col gap-1">
                        <span className="text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {cap.title}
                        </span>
                        <span className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          {cap.summary}
                        </span>
                        {writeOnly && (
                          <span
                            className="text-[11.5px] leading-relaxed"
                            style={{ color: 'var(--semantic-warning-text)' }}
                          >
                            这块能力没有「只看」的档位：勾上就是允许它生成内容、写进你的空间。
                          </span>
                        )}
                      </span>
                    </label>

                    {disabled && (
                      <span
                        className="flex items-center gap-1.5 text-[11.5px]"
                        style={{ color: 'var(--semantic-warning-text)' }}
                      >
                        <ShieldAlert size={13} aria-hidden />
                        你自己还没有这块权限，得先找管理员开通，勾了也签不出密钥
                      </span>
                    )}

                    {!disabled && pick.read && cap.writeScope && cap.readScope && (
                      <label
                        className={`flex items-center gap-2 rounded-[9px] px-2.5 py-2 ${writeDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        style={{
                          background: 'var(--semantic-orange-soft)',
                          border: '1px solid var(--semantic-orange-border)',
                          opacity: writeDisabled ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          disabled={writeDisabled}
                          checked={pick.write && !writeDisabled}
                          onChange={(e) =>
                            setSelected((prev) => ({
                              ...prev,
                              [cap.key]: { read: true, write: e.target.checked },
                            }))
                          }
                        />
                        <span className="text-[12px]" style={{ color: 'var(--semantic-warning-text)' }}>
                          {writeDisabled
                            ? '你只有这块能力的只读权限，写入得先找管理员开通'
                            : '也允许它写入（会在平台里留下东西）'}
                        </span>
                      </label>
                    )}
                  </div>
                );
              })}
              <p
                className="rounded-[10px] px-3 py-2.5 text-[11.5px] leading-relaxed"
                style={{ background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
              >
                删除和公开发布这类收不回来的动作，这一版一律不开放给智能体 —— 不管你怎么勾。
              </p>
            </div>
          )}

          {step === 'key' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  给这台客户端起个名（撤销时按名字找）
                </span>
                <input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="h-9 rounded-[10px] px-3 text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
              <div
                className="flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5"
                style={{ background: 'var(--nested-block-bg)' }}
              >
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  这把钥匙会带上这些能力
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {scopes.map((s) => (
                    <code
                      key={s}
                      className="rounded-[6px] px-1.5 py-0.5 text-[10.5px]"
                      style={{
                        background: 'var(--bg-card)',
                        color: 'var(--text-muted)',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      }}
                    >
                      {s}
                    </code>
                  ))}
                  {scopes.length === 0 && (
                    <span className="text-[11.5px]" style={{ color: 'var(--semantic-warning-text)' }}>
                      还没勾任何能力
                    </span>
                  )}
                </div>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  有效期 90 天，到期前可在密钥管理里续期；明文只显示一次。
                </span>
              </div>
            </div>
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

              <div className="flex gap-1 rounded-[11px] p-1" style={{ background: 'var(--nested-block-bg)' }}>
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
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {configTab === 'claude-code' ? '在终端里跑这一行' : '粘进配置文件'}
                  </span>
                  <CopyButton text={configSnippet} label="复制配置" />
                </div>
                <pre
                  className="overflow-x-auto rounded-[11px] px-3.5 py-3 text-[11.5px] leading-relaxed"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-faint)',
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
                  <div className="flex items-center gap-2">
                    <Check size={15} style={{ color: 'var(--semantic-success-text)' }} aria-hidden />
                    <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      授权自检通过：这把钥匙能看到 {visible.toolCount} 个工具
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {visible.tools.slice(0, 8).map((t) => (
                      <code
                        key={t.name}
                        className="rounded-[6px] px-1.5 py-0.5 text-[10.5px]"
                        style={{
                          background: 'var(--bg-card)',
                          color: 'var(--text-muted)',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        }}
                      >
                        {t.name}
                      </code>
                    ))}
                    {visible.tools.length > 8 && (
                      <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                        还有 {visible.tools.length - 8} 个
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    这一步核的是授权对不对（服务端按 scope 算的），不代表你的客户端已经连通 —— 那要等你把上面的配置粘过去。
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 底部动作 */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {step === 'capabilities' && `已选 ${scopes.length} 个授权项`}
              {step === 'key' && '创建后明文只显示一次'}
              {step === 'connect' && '粘完配置，回到客户端说一句话就能用'}
            </span>
            <div className="flex gap-2">
              {step === 'capabilities' && (
                <button
                  type="button"
                  disabled={scopes.length === 0}
                  onClick={() => setStep('key')}
                  className="h-9 rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
                >
                  下一步：出钥匙
                </button>
              )}
              {step === 'key' && (
                <>
                  <button
                    type="button"
                    onClick={() => setStep('capabilities')}
                    className="h-9 rounded-[10px] px-4 text-[13px] font-medium"
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    返回
                  </button>
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => void createKey()}
                    className="h-9 rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-60"
                    style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
                  >
                    {creating ? '正在签发…' : '生成密钥'}
                  </button>
                </>
              )}
              {step === 'connect' && (
                <button
                  type="button"
                  onClick={() => handleClose(false)}
                  className="h-9 rounded-[10px] px-4 text-[13px] font-semibold"
                  style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
                >
                  完成
                </button>
              )}
            </div>
          </div>
        </div>
      }
    />
  );
}

function StepBar({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'capabilities', label: '选能力' },
    { key: 'key', label: '出钥匙' },
    { key: 'connect', label: '接上' },
  ];
  const currentIndex = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex items-center gap-2.5">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <div key={s.key} className="flex flex-1 items-center gap-2.5">
            <span
              className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
              style={
                active || done
                  ? { background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }
                  : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }
              }
            >
              {i + 1}
            </span>
            <span
              className="text-[12.5px]"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: active ? 600 : 400,
              }}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
            )}
          </div>
        );
      })}
    </div>
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
