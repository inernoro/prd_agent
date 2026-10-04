import crypto from 'node:crypto';

/** 仅在实例私有状态中保存，不从域名、主机名或 IP 推断显示身份。 */
export interface AlarmInstanceIdentity {
  id: string;
  name: string;
  environment: string;
  location?: string;
}
export interface AlarmIdentitySettings {
  instance: AlarmInstanceIdentity;
  targets?: Record<string, AlarmInstanceIdentity>;
}
export interface AlarmIdentity {
  observer: AlarmInstanceIdentity;
  subject: AlarmInstanceIdentity;
}

export function parseAlarmIdentity(value: unknown, previous?: AlarmIdentitySettings): AlarmIdentitySettings {
  const body = value as Partial<AlarmIdentitySettings> | null;
  const parse = (raw: unknown, id?: string): AlarmInstanceIdentity => {
    const v = raw as Partial<AlarmInstanceIdentity> | null;
    const label = (s: unknown, required: boolean): string => {
      if (typeof s !== 'string' || !s.trim()) {
        if (required) throw new Error('实例名称和环境必填');
        return '';
      }
      if (s.length > 64 || /[\x00-\x1f\x7f]|https?:\/\/|PRIVATE KEY/i.test(s)) throw new Error('身份请使用 64 字以内的显示名称，不要填写地址或凭据');
      return s.trim();
    };
    const location = label(v?.location, false);
    return { id: id || crypto.randomUUID(), name: label(v?.name, true), environment: label(v?.environment, true), ...(location ? { location } : {}) };
  };
  const result: AlarmIdentitySettings = { instance: parse(body?.instance, previous?.instance.id) };
  const targets = body?.targets ?? previous?.targets;
  if (targets) {
    if (typeof targets !== 'object' || Array.isArray(targets) || Object.keys(targets).length > 100) throw new Error('监控对象身份配置无效');
    result.targets = {};
    for (const [key, v] of Object.entries(targets)) {
      if (!/^(monitor@|release@)[a-zA-Z0-9_.-]{1,128}$/.test(key)) throw new Error('监控目标标识无效');
      const identity = parse(v, previous?.targets?.[key]?.id);
      // 对端明确提供稳定 ID 时使用它，不能以显示名作为去重依据。
      if (typeof v?.id === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(v.id)) identity.id = v.id;
      result.targets[key] = identity;
    }
  }
  return result;
}

export function identityForAlarm(settings: AlarmIdentitySettings | undefined, targetId?: string): AlarmIdentity | undefined {
  return settings ? { observer: settings.instance, subject: settings.targets?.[targetId || ''] || settings.instance } : undefined;
}
export function identityLabel(identity: AlarmInstanceIdentity): string {
  return [identity.name, identity.environment, identity.location].filter(Boolean).join(' · ');
}
