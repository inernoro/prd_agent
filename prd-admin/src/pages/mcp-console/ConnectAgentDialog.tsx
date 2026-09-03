import { useCallback, useMemo, useState } from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { createAgentApiKey, getMcpVisibleTools } from '@/services';
import type { McpCapabilityDto, McpVisibleToolsDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';

type Step = 'capabilities' | 'key' | 'connect';

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
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) reset();
    },
    [onOpenChange, reset],
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
    setPlaintext(res.data.apiKey);
    const keyId = res.data.item?.id;
    // 自检这一段还在网络里，按钮不能先解锁 —— 解锁了用户再点一次就又签出一把钥匙，
    // 而且后签的那把会把界面上显示的明文覆盖掉，他手里就多了一把自己不知道的钥匙。
    if (keyId) {
      const check = await getMcpVisibleTools(keyId);
      if (check.success && check.data) setVisible(check.data);
    }
    onCreated();
    setStep('connect');
    setCreating(false);
  }, [clientName, scopes, onCreated]);

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
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[11.5px] font-medium"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      {copied ? '已复制' : label}
    </button>
  );
}
