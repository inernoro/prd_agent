import { useState, useEffect } from 'react';
import { Github, BookOpen, GitBranch, Link2, Save, X } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { updateIdentityMappings } from '@/services';
import type { ReportTeamMember } from '@/services/contracts/reportAgent';

interface IdentityMappingEditorProps {
  teamId: string;
  member: ReportTeamMember;
  onClose: () => void;
  onSaved: () => void;
}

const PLATFORMS = [
  { key: 'github', label: 'GitHub', icon: Github, placeholder: 'GitHub 用户名' },
  { key: 'tapd', label: 'TAPD', icon: Link2, placeholder: 'TAPD 邮箱 (如 zhangsan@company.com)' },
  { key: 'yuque', label: '语雀', icon: BookOpen, placeholder: '语雀 login ID' },
  { key: 'gitlab', label: 'GitLab', icon: GitBranch, placeholder: 'GitLab 用户名' },
] as const;

export function IdentityMappingEditor({ teamId, member, onClose, onSaved }: IdentityMappingEditorProps) {
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMappings({ ...member.identityMappings });
  }, [member]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await updateIdentityMappings({
        teamId,
        userId: member.userId,
        identityMappings: mappings,
      });
      if (res.success) {
        onSaved();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const updateMapping = (key: string, value: string) => {
    setMappings(prev => {
      const next = { ...prev };
      if (value.trim()) {
        next[key] = value.trim();
      } else {
        delete next[key];
      }
      return next;
    });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'var(--modal-overlay)' }}>
      <GlassCard className="w-[420px] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
              身份映射 — {member.userName || member.userId}
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              配置成员在各平台的用户标识，用于自动归属采集数据
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        <div className="space-y-2.5">
          {PLATFORMS.map(platform => {
            const Icon = platform.icon;
            return (
              <div key={platform.key} className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 w-20 shrink-0">
                  <Icon size={12} style={{ color: 'var(--text-secondary)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{platform.label}</span>
                </div>
                <input
                  value={mappings[platform.key] || ''}
                  onChange={e => updateMapping(platform.key, e.target.value)}
                  placeholder={platform.placeholder}
                  className="flex-1 px-2.5 py-1.5 rounded text-[12px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                />
              </div>
            );
          })}
        </div>

        <div className="text-[11px] p-2 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
          提示: 系统通过 assignee 字段匹配，TAPD 通常使用邮箱，GitHub/GitLab 使用用户名
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            <Save size={12} /> {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
