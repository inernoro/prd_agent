/**
 * 就地添加服务器 —— 加环境的第一步不再把人踢去 CDS 系统设置。
 *
 * 为什么必须就地做（少绕路原则）：
 *   原来这里只有一句「还没有可用服务器，先到 CDS 系统设置 / Remote Hosts 添加 SSH 凭据」。
 *   于是一个想加环境的人要：离开这个弹窗 → 换一个页面 → 在那边理解另一套概念（Remote Hosts）
 *   → 加完 → 回来 → 重新走一遍向导。全程还得自己记住刚才填到哪了。
 *   能一步做完的事不许拆成两页。
 *
 * 三种接法一并给，因为「手上有什么」因人而异：
 *   - CDS 生成密钥对：什么都没有的人。私钥留在 CDS，只把公钥给你去授权，私钥一次都不过网络。
 *   - 粘贴私钥：手上已经有一把 key 的人。
 *   - 用户名密码：只有一串密码的人。以前这类人根本进不来。
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Loader2, Plus, ServerCog, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { parseSshTarget, suggestHostName } from '@/lib/sshTarget';
import type { RemoteHostOption } from './types';

type AuthMode = 'generate' | 'private-key' | 'password';

const AUTH_MODES: Array<{ value: AuthMode; label: string; hint: string }> = [
  { value: 'generate', label: 'CDS 生成密钥对', hint: '私钥留在 CDS，把公钥加到服务器即可' },
  { value: 'private-key', label: '粘贴私钥', hint: '已经有一把可用的 SSH 私钥' },
  { value: 'password', label: '用户名密码', hint: '只有一串登录密码' },
];

interface CreatedHostResponse {
  host: RemoteHostOption & { publicKey?: string; authMethod?: string };
}

const INPUT_CLASS = 'h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60';

export function InlineHostCreator({
  defaultOpen,
  onCreated,
}: {
  /** 一台服务器都没有时直接展开：此时折叠等于把人挡在门外。 */
  defaultOpen: boolean;
  /** 新服务器已创建：把创建接口返回的这台主机交给父级并入列表并选中，向导原地继续。 */
  onCreated: (host: RemoteHostOption) => void | Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [quickInput, setQuickInput] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [authMode, setAuthMode] = useState<AuthMode>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; publicKey?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /**
   * 粘贴即填。解析不出来就什么都不做——绝不清空用户已经敲进去的字段
   * （把人辛苦填的东西擦掉，比不解析更气人）。
   */
  const applyQuickInput = (value: string): void => {
    setQuickInput(value);
    const parsed = parseSshTarget(value);
    if (!parsed) return;
    setHost(parsed.host);
    setPort(String(parsed.port));
    if (parsed.user) setUser(parsed.user);
    setName((current) => current.trim() || suggestHostName(parsed.host));
  };

  const credentialReady = authMode === 'generate'
    || (authMode === 'private-key' && privateKey.trim().length > 0)
    || (authMode === 'password' && password.trim().length > 0);
  const canSave = Boolean(host.trim() && user.trim() && credentialReady) && !saving;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    // 显示名在 catch 里还要用（重名提示要指名道姓），所以提到 try 外算好。
    const displayName = name.trim() || suggestHostName(host) || host.trim();
    try {
      const body: Record<string, unknown> = {
        name: displayName,
        host: host.trim(),
        sshPort: Number(port) || 22,
        sshUser: user.trim(),
      };
      if (authMode === 'generate') body.generateKeyPair = true;
      if (authMode === 'private-key') {
        body.sshPrivateKey = privateKey;
        if (passphrase.trim()) body.sshPassphrase = passphrase;
      }
      if (authMode === 'password') body.sshPassword = password;

      const response = await apiRequest<CreatedHostResponse>('/api/cds-system/remote-hosts', {
        method: 'POST',
        body,
      });
      const createdHost = response.host;
      setCreated({ id: createdHost.id, publicKey: createdHost.publicKey });
      // 私钥/密码明文留在内存里没有意义，存完立刻丢。
      setPrivateKey('');
      setPassphrase('');
      setPassword('');
      await onCreated(createdHost);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 后端的重名校验是全局的，但报出来是一句英文 + HTTP 409 + requestId，
      // 对着「显示名」那个框的人完全不知道该改哪里。翻成一句能照做的话。
      setError(/already exists/i.test(raw)
        ? `显示名「${displayName}」已被占用，换一个显示名再保存。`
        : raw);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    if (!created) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiRequest<{ ok: boolean; message?: string }>(
        `/api/cds-system/remote-hosts/${encodeURIComponent(created.id)}/test`,
        { method: 'POST', body: {} },
      );
      setTestResult({ ok: result.ok, message: result.message || (result.ok ? '连接成功' : '连接失败') });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const copyPublicKey = async (): Promise<void> => {
    if (!created?.publicKey) return;
    try {
      await navigator.clipboard.writeText(created.publicKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板被浏览器策略拒绝时公钥本身仍然可选中复制，不必打断用户。
    }
  };

  if (created) {
    return (
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Check className="h-4 w-4" />
          服务器已添加，已自动选中
        </div>
        {created.publicKey ? (
          <div className="mt-3 space-y-2">
            <div className="text-xs text-muted-foreground">
              把这把公钥加到服务器的 authorized_keys，CDS 才连得上。私钥留在 CDS，不会给出来。
            </div>
            <textarea
              readOnly
              value={created.publicKey}
              rows={3}
              className="w-full resize-none rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2 font-mono text-xs outline-none"
            />
            <div className="text-xs text-muted-foreground">
              在服务器上执行一次即可：
            </div>
            <pre className="overflow-x-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2 font-mono text-xs">
{`mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '${created.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void copyPublicKey()}>
                {copied ? <Check /> : <Copy />}
                {copied ? '已复制' : '复制公钥'}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void runTest()} disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <ServerCog />}
                测试连接
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <Button type="button" size="sm" variant="outline" onClick={() => void runTest()} disabled={testing}>
              {testing ? <Loader2 className="animate-spin" /> : <ServerCog />}
              测试连接
            </Button>
          </div>
        )}
        {testResult ? (
          <div className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${
            testResult.ok
              ? 'bg-ok-soft text-ok'
              : 'bg-bad-soft text-bad'
          }`}
          >
            {testResult.message}
          </div>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus />
        添加新服务器
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">添加新服务器</span>
        {defaultOpen ? null : (
          <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <label className="grid gap-1 text-sm">
        <span className="text-muted-foreground">粘贴连接串，下面的字段自动填好</span>
        <input
          value={quickInput}
          onChange={(event) => applyQuickInput(event.target.value)}
          placeholder="ssh root@host.example.com -p 22   或   root@1.2.3.4:22"
          className={INPUT_CLASS}
        />
      </label>

      <div className="grid gap-2 md:grid-cols-4">
        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">主机</span>
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="host.example.com" className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">端口</span>
          <input value={port} onChange={(event) => setPort(event.target.value)} placeholder="22" className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">用户</span>
          <input value={user} onChange={(event) => setUser(event.target.value)} placeholder="root" className={INPUT_CLASS} />
        </label>
      </div>

      <label className="grid gap-1 text-sm">
        <span className="text-muted-foreground">显示名（留空按主机名生成）</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={suggestHostName(host) || '生产服务器'} className={INPUT_CLASS} />
      </label>

      <div className="grid gap-2">
        <span className="text-sm text-muted-foreground">怎么登录</span>
        <div className="grid gap-2 md:grid-cols-3">
          {AUTH_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => setAuthMode(mode.value)}
              className={`rounded-md border p-2 text-left ${
                authMode === mode.value
                  ? 'border-primary/45 bg-primary/10'
                  : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/60 hover:bg-[hsl(var(--surface-sunken))]'
              }`}
            >
              <span className="block text-sm font-medium">{mode.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{mode.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {authMode === 'private-key' ? (
        <div className="grid gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">私钥（PEM）</span>
            <textarea
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full resize-y rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2 font-mono text-xs outline-none focus:border-primary/60"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">私钥口令（没有就留空）</span>
            <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className={INPUT_CLASS} />
          </label>
        </div>
      ) : null}

      {authMode === 'password' ? (
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">登录密码</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT_CLASS} />
        </label>
      ) : null}

      {authMode === 'generate' ? (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/60 px-3 py-2 text-xs text-muted-foreground">
          保存后 CDS 会生成一对密钥并给出公钥，你把公钥加到服务器的 authorized_keys 即可。私钥留在 CDS，一次都不经过浏览器。
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">{error}</div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          也可以去 <Link className="underline" to="/cds-settings#remote-hosts">CDS 系统设置 / Remote Hosts</Link> 集中管理已有服务器。
        </span>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" /> : <Plus />}
          保存并选用
        </Button>
      </div>
    </div>
  );
}
