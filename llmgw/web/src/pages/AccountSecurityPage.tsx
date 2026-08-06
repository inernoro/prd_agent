// 账号与安全。
//
// 补的是一处断头：MAP 一键登录会自动建网关账号，用户名是 map-{hash}、口令是建号时随机生成的，
// 两个值没人知道；而控制台既不显示登录名，也没有任何入口能设置口令。于是「网关明明有口令，
// 却登不进去，也改不了」。这一页把三件事同时给出来：我的登录名是什么、有没有可用的口令、
// 在哪里设置它。判定（要不要旧口令、登录名合法性）由后端 LocalPasswordPolicy 单点权威，
// 这里只渲染它给的结论，不在前端复写一份。
import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, UserRound } from 'lucide-react';
import { getAccountProfile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { AccountProfile } from '@/lib/types';
import { Button, Card, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, PageBody, PageHeader, PageShell } from '@/components/PageShell';
import { CARD_BODY, GAP } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE } from '@/lib/typography';

export function AccountSecurityPage() {
  const { changePassword } = useAuth();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const res = await getAccountProfile();
    if (res.success && res.data) {
      setProfile(res.data);
      setUsername(res.data.usernameIsGenerated ? '' : res.data.username);
      setLoadError(null);
    } else {
      setLoadError(res.error?.message || '读取账号信息失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const minLength = profile?.minPasswordLength ?? 12;
  const needsOld = profile?.requiresOldPassword === true;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    if (needsOld && !oldPassword) return setError('请填写当前口令');
    if (newPassword.length < minLength) return setError(`新口令至少 ${minLength} 位`);
    if (newPassword !== confirm) return setError('两次输入的新口令不一致');
    if (profile.usernameIsGenerated && !username.trim()) return setError('请先设置一个记得住的登录名');

    setSubmitting(true);
    setError(null);
    const trimmed = username.trim();
    const res = await changePassword({
      oldPassword: needsOld ? oldPassword : undefined,
      newPassword,
      username: trimmed && trimmed !== profile.username ? trimmed : undefined,
    });
    setSubmitting(false);
    if (!res.success) return setError(res.error?.message || '设置失败，请重试');

    setOldPassword('');
    setNewPassword('');
    setConfirm('');
    setDone(true);
    await load();
  };

  if (loadError) {
    return (
      <PageShell>
        <PageHeader title="账号与安全" />
        <PageBody><InlineAlert tone="error">{loadError}</InlineAlert></PageBody>
      </PageShell>
    );
  }
  if (!profile) {
    return (
      <PageShell>
        <PageHeader title="账号与安全" />
        <PageBody><SectionLoader text="读取账号信息" /></PageBody>
      </PageShell>
    );
  }

  const federated = !!profile.identityProvider;

  return (
    <PageShell>
      <PageHeader
        title="账号与安全"
        subtitle="管理你在模型网关的登录名与口令。"
        summary={
          <>
            {profile.tenant?.name ?? '当前租户'} · {profile.tenant?.role ?? 'member'} ·{' '}
            {federated ? 'MAP 一键登录' : '独立口令账号'}
          </>
        }
      />
      <PageBody>
        <div style={{ display: 'grid', gap: GAP.section, maxWidth: 720 }}>
          <Card style={CARD_BODY}>
            <div style={{ ...SECTION_TITLE, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <UserRound size={15} />登录凭据
            </div>
            <div style={{ display: 'grid', gap: GAP.normal }}>
              <Row label="登录名">
                <span style={MONO_META}>{profile.username}</span>
                {profile.usernameIsGenerated ? <Chip label="自动生成" color="var(--warn)" bg="var(--warn-bg)" /> : null}
              </Row>
              <Row label="口令登录">
                {profile.hasLocalPassword
                  ? <Chip label="可用" color="var(--ok)" bg="var(--ok-bg)" />
                  : <Chip label="尚未设置" color="var(--warn)" bg="var(--warn-bg)" />}
              </Row>
            </div>
            {profile.hasLocalPassword ? null : (
              <p style={{ ...HINT_TEXT, marginTop: 10 }}>
                这个账号由一键登录自动创建，口令是随机生成的，因此现在只能从 MAP 进入。在下方设置口令后即可直接登录网关。
              </p>
            )}
          </Card>

          <Card style={CARD_BODY}>
            <div style={{ ...SECTION_TITLE, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <KeyRound size={15} />{profile.hasLocalPassword ? '修改口令' : '设置口令'}
            </div>
            <form onSubmit={submit} style={{ display: 'grid', gap: GAP.section }}>
              <FormGrid>
                {profile.usernameIsGenerated || !federated ? (
                  <label style={{ display: 'grid', gap: 4 }}>
                    <span style={FIELD_LABEL}>登录名</span>
                    <input
                      style={FIELD_INPUT}
                      value={username}
                      autoComplete="username"
                      placeholder="小写字母、数字、点、下划线、连字符"
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </label>
                ) : null}
                {needsOld ? (
                  <label style={{ display: 'grid', gap: 4 }}>
                    <span style={FIELD_LABEL}>当前口令</span>
                    <input
                      style={FIELD_INPUT}
                      type="password"
                      autoComplete="current-password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                    />
                  </label>
                ) : null}
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={FIELD_LABEL}>新口令</span>
                  <input
                    style={FIELD_INPUT}
                    type="password"
                    autoComplete="new-password"
                    placeholder={`至少 ${minLength} 位`}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={FIELD_LABEL}>确认新口令</span>
                  <input
                    style={FIELD_INPUT}
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
              </FormGrid>

              {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
              {done && !error ? (
                <InlineAlert tone="ok">
                  <Check size={14} style={{ verticalAlign: -2 }} /> 已生效，下次可用「{profile.username}」直接登录网关。
                </InlineAlert>
              ) : null}

              <div>
                <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                  {submitting ? '提交中…' : profile.hasLocalPassword ? '保存' : '设置口令'}
                </Button>
              </div>
            </form>

            <DetailsBlock title="口令与一键登录的关系">
              <p>
                网关是独立账号体系，口令只对网关有效，与 MAP 的口令互不影响。设置之后两条路都能进：
                从 MAP 一键登录，或在网关登录页直接输入登录名与口令。
              </p>
              <p>
                口令修改后当前所有会话立即失效，需要重新登录；忘记口令时，请联系租户 Owner 从组织页重置。
              </p>
            </DetailsBlock>
          </Card>
        </div>
      </PageBody>
    </PageShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ ...FIELD_LABEL, minWidth: 72 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{children}</span>
    </div>
  );
}
