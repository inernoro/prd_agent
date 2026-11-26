export const accountPermissionDescription = '管理员管理普通成员。系统设置与高风险批准由系统所有者负责。';

const permissionRows = [
  ['创建普通成员', '可执行', '可执行', '—', '—'],
  ['授予管理员', '可执行', '—', '—', '—'],
  ['停用无在线会话的成员、恢复账号', '执行并留档', '管理范围内执行', '—', '—'],
  ['重置他人口令、停用在线账号、退出会话', '逐次确认', '对成员提交申请', '—', '授权设备仅在项目内提案'],
  ['撤销管理员', '逐次确认', '—', '—', '—'],
  ['修改本人口令', '个人账号可用', '可执行', '可执行', '—'],
  ['账号审计', '全部', '本人及管理范围内的普通成员', '本人', '仅回读本设备提案'],
] as const;

export function AccountPermissionMatrix(): JSX.Element {
  const columns = ['系统所有者', '管理员', '成员', '智能体'];
  return <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {columns.map((column, index) => <li className="min-w-0 rounded-lg border border-border bg-card p-4" key={column}>
      <h3 className="mb-2 font-semibold">{column}</h3>
      <dl className="divide-y divide-border text-sm">{permissionRows.map(([action, ...scope]) => <div className="py-2" key={action}>
        <dt className="text-muted-foreground">{action}</dt><dd className="font-medium">{scope[index]}</dd>
      </div>)}</dl>
    </li>)}
  </ul>;
}
