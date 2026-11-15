import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';

type AvatarMember = { displayName: string; avatarFileName?: string | null };

/** 统计里的同一人物始终使用真实头像；未设置头像时显示姓名首字占位。 */
export function ExecutiveMemberAvatar({ member, label = member.displayName, anonymous = false }: {
  member: AvatarMember;
  label?: string;
  anonymous?: boolean;
}) {
  return (
    <span className="exec-avatar" title={label}>
      {member.avatarFileName && !anonymous ? (
        <UserAvatar src={resolveAvatarUrl(member)} alt={`${label}的头像`} className="exec-avatar-image" loading="lazy" />
      ) : (
        <span className="exec-avatar-initial" role="img" aria-label={`${label}的姓名头像`}>
          {Array.from(label.trim())[0] || '人'}
        </span>
      )}
    </span>
  );
}
