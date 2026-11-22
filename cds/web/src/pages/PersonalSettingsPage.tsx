import { useContext, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { AppShell, ConsoleAuthContext, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { MotionLink } from '@/components/layout/RouteMotion';
import { Button } from '@/components/ui/button';
import { ApiError, changeMyPassword } from '@/lib/api';
import { consoleAccountIdentity } from '@/lib/consoleIdentity';
import { approveSystemPasswordChange } from '@/lib/passkeys';
import { ErrorBlock, LoadingBlock, Section } from './cds-settings/components';

const passwordInputClass = 'min-h-11 w-full rounded-md border border-border bg-input px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm';

function passwordError(error: unknown, systemAccount: boolean): string {
  if (error instanceof ApiError) {
    const code = error.body && typeof error.body === 'object' && 'code' in error.body ? error.body.code : null;
    switch (code) {
      case 'invalid_credentials': return '原密码不正确，请重新输入。';
      case 'password_too_short': return '新密码至少需要 8 个字符，请重新输入。';
      case 'invalid_new_password': return '请设置与原密码不同的新密码，且不要包含换行。';
      case 'system_password_approval_unavailable': return '此站点尚未配置改密审批通行密钥，请联系系统运维。';
      case 'system_password_approval_required': return '请用已指定的管理员通行密钥批准本次改密。';
      case 'system_password_stale': return '系统密码已变更，请重新登录后再发起。';
      case 'system_password_origin_invalid':
      case 'system_password_human_required': return '请使用系统所有者账号登录 CDS 后重新发起改密。';
      case 'not_local_account': return '当前账号的密码由登录服务管理，请在那里修改。';
    }
    if (error.status === 401) return '登录已过期，请重新登录后再修改密码。';
    if (error.status === 429) return '请求过多，请稍后重试。';
    return '改密请求未能确认，请稍后重试。';
  }
  return systemAccount ? '管理员通行密钥未完成验证，请重试。' : '改密请求未能确认，请稍后重试。';
}

function PasswordForm({ systemAccount }: { systemAccount: boolean }): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = {
      oldPassword: String(data.get('oldPassword') ?? ''),
      newPassword: String(data.get('newPassword') ?? ''),
    };
    setError('');
    setPending(true);
    try {
      if (systemAccount) {
        await approveSystemPasswordChange(password);
      } else {
        await changeMyPassword(password);
      }
      form.reset();
      setChanged(true);
    } catch (err) {
      setError(passwordError(err, systemAccount));
    } finally {
      setPending(false);
    }
  }

  if (changed) return (
    <div className="space-y-3">
      <p role="status" className="text-sm">密码已修改，请使用新密码重新登录。</p>
      <Button asChild><MotionLink to="/login">重新登录</MotionLink></Button>
    </div>
  );

  return (
    <form onSubmit={submit} className="max-w-md space-y-4" aria-busy={pending}>
      <label className="block space-y-1.5 text-sm font-medium">
        <span>原密码</span>
        <input name="oldPassword" type="password" autoComplete="current-password" required disabled={pending} className={passwordInputClass} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium">
        <span>新密码（至少 8 个字符）</span>
        <input name="newPassword" type="password" autoComplete="new-password" required minLength={8} disabled={pending} className={passwordInputClass} />
      </label>
      {error ? <div role="alert"><ErrorBlock message={error} /></div> : null}
      <Button type="submit" disabled={pending} className="min-h-11">
        <KeyRound />
        {pending ? (systemAccount ? '等待通行密钥验证…' : '正在修改…') : systemAccount ? '使用通行密钥批准并改密' : '修改密码'}
      </Button>
    </form>
  );
}

export function PersonalSettingsPage(): JSX.Element {
  const { status, pending, retry } = useContext(ConsoleAuthContext);
  const identity = consoleAccountIdentity(status);
  const user = status?.user;
  const systemAccount = user?.authProvider === 'legacy' && user.isSystemOwner === true;
  const localAccount = user?.authProvider === 'local';
  return (
    <AppShell active="personal-settings" topbar={<TopBar left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '个人设置' }]} />} />}>
      <Workspace fluid>
        <div className="max-w-xl space-y-5 py-5">
          <h1 className="text-xl font-semibold">个人设置</h1>
          <Section title="修改密码" description={localAccount ? '修改当前本地账号的登录密码。修改后，请使用新密码重新登录。'
            : systemAccount ? '由指定的系统所有者使用通行密钥批准本次改密。批准人和时间会记入用户操作痕迹。' : undefined}>
            {pending ? <LoadingBlock label="确认当前账号" /> : !status ? (
              <div className="space-y-3"><ErrorBlock message="暂时无法确认当前账号，请重新读取登录状态。" /><Button onClick={retry}>重新读取</Button></div>
            ) : identity && (localAccount || systemAccount) ? (
              <PasswordForm key={identity} systemAccount={systemAccount} />
            ) : user?.authProvider === 'github' || user?.authProvider === 'sso' ? (
              <p className="text-sm text-muted-foreground">请在你登录 CDS 所用的账号服务里修改密码。</p>
            ) : (
              <p className="text-sm text-muted-foreground">当前登录方式没有可在这里修改的密码。需要帮助时，请联系系统所有者。</p>
            )}
          </Section>
        </div>
      </Workspace>
    </AppShell>
  );
}
