import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Plus, Tag, Trash2, User as UserIcon, X } from 'lucide-react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { getTeam, type TeamMember } from '@/services/real/teams';
import {
  updateSiteGroupAccess,
  type WebPageGroup,
  type WebPageGroupAccessRule,
  type WebPageGroupRole,
  type WebPageGroupVisibility,
} from '@/services/real/webPages';

/**
 * 分组（专题/日常分类）权限设置弹窗 — 仅空间 owner 可见入口。
 *
 * 两档可见性：
 * - inherit：跟随空间角色（默认），人人按空间角色访问
 * - restricted：受限，仅空间 owner 与下方授权规则命中的成员可见；
 *   规则按「成员」或「角色标签」授予 可看(viewer) / 可编辑(editor)
 */
export function GroupAccessDialog({
  group,
  teamId,
  onClose,
  onSaved,
}: {
  group: WebPageGroup;
  teamId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [visibility, setVisibility] = useState<WebPageGroupVisibility>(group.visibility ?? 'inherit');
  const [rules, setRules] = useState<WebPageGroupAccessRule[]>(group.accessRules ?? []);
  const [saving, setSaving] = useState(false);
  // 新规则编辑区
  const [subjectType, setSubjectType] = useState<'user' | 'label'>('user');
  const [subjectId, setSubjectId] = useState('');
  const [role, setRole] = useState<WebPageGroupRole>('viewer');

  useEffect(() => {
    let alive = true;
    void getTeam(teamId).then((r) => { if (alive && r.success) setMembers(r.data.members); });
    return () => { alive = false; };
  }, [teamId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const labelDict = useMemo(
    () => [...new Set(members.flatMap((m) => m.labels ?? []))],
    [members],
  );
  const memberName = (userId: string) =>
    members.find((m) => m.userId === userId)?.userName ?? userId;

  const addRule = () => {
    const id = subjectId.trim();
    if (!id) return;
    if (rules.some((r) => r.subjectType === subjectType && r.subjectId === id)) {
      toast.error('已存在', '该对象已有授权规则，可直接调整其角色');
      return;
    }
    setRules([...rules, { subjectType, subjectId: id, role }]);
    setSubjectId('');
  };

  const save = async () => {
    if (visibility === 'restricted' && rules.length === 0) {
      if (!confirm('受限分组没有任何授权规则：除空间所有者外所有成员都将看不到该分组及组内网页。确认保存？')) return;
    }
    setSaving(true);
    const res = await updateSiteGroupAccess(group.id, {
      visibility,
      rules: visibility === 'restricted' ? rules : [],
    });
    setSaving(false);
    if (res.success) {
      toast.success('已保存', `「${group.name}」权限已更新`);
      onSaved();
      onClose();
    } else {
      toast.error('保存失败', res.error?.message);
    }
  };

  const segBtn = (on: boolean) => (on
    ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)', border: '1px solid rgba(212,175,55,0.4)' }
    : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' });

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-[14px] flex flex-col w-full"
        style={{
          maxHeight: '76vh',
          maxWidth: '560px',
          background: 'var(--bg-elevated)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 h-[52px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Lock size={15} /> 「{group.name}」访问权限
          </span>
          <button type="button" onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        <div
          className="flex-1 px-5 py-4 space-y-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* 可见性 */}
          <div className="space-y-1.5">
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>谁能看到这个{group.kind === 'topic' ? '专题' : '分类'}</div>
            <div className="flex gap-1.5">
              <button type="button" className="h-8 px-3 rounded-[8px] text-[12px]" style={segBtn(visibility === 'inherit')} onClick={() => setVisibility('inherit')}>
                跟随空间（全员按空间角色）
              </button>
              <button type="button" className="h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1" style={segBtn(visibility === 'restricted')} onClick={() => setVisibility('restricted')}>
                <Lock size={11} /> 受限（仅授权成员）
              </button>
            </div>
            {visibility === 'restricted' && (
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                受限后：空间所有者始终可见；其余成员需被下方规则授权，未授权者完全看不到该分组及组内网页。
              </div>
            )}
          </div>

          {/* 授权规则 */}
          {visibility === 'restricted' && (
            <div className="space-y-2">
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>授权规则（按成员或角色标签）</div>

              {rules.length === 0 ? (
                <div className="text-[12px] py-3 text-center rounded-[8px]" style={{ background: 'var(--bg-input)', border: '1px dashed rgba(255,255,255,0.12)', color: 'var(--text-muted)' }}>
                  还没有授权规则，下方添加成员或标签
                </div>
              ) : (
                <div className="space-y-1">
                  {rules.map((r, i) => (
                    <div key={`${r.subjectType}-${r.subjectId}`} className="flex items-center gap-2 h-9 px-2.5 rounded-[8px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {r.subjectType === 'user' ? (
                        <>
                          <UserAvatar
                            src={resolveAvatarUrl({ avatarFileName: members.find((m) => m.userId === r.subjectId)?.avatarFileName })}
                            className="w-5 h-5 rounded-full shrink-0"
                          />
                          <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{memberName(r.subjectId)}</span>
                        </>
                      ) : (
                        <>
                          <Tag size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                            {r.subjectId}
                            <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>标签</span>
                          </span>
                        </>
                      )}
                      <select
                        value={r.role}
                        onChange={(e) => setRules(rules.map((x, xi) => (xi === i ? { ...x, role: e.target.value as WebPageGroupRole } : x)))}
                        className="h-6 px-1.5 rounded-[6px] text-[11px] outline-none"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                      >
                        <option value="viewer">可看</option>
                        <option value="editor">可编辑</option>
                      </select>
                      <button type="button" title="移除规则" onClick={() => setRules(rules.filter((_, xi) => xi !== i))} style={{ color: 'var(--text-muted)' }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 添加规则 */}
              <div className="flex items-center gap-1.5">
                <div className="flex rounded-[8px] overflow-hidden shrink-0" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
                  <button type="button" title="按具体成员授权" className="h-8 px-2 text-[11px] flex items-center gap-1" style={subjectType === 'user' ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)' } : { background: 'var(--bg-input)', color: 'var(--text-muted)' }} onClick={() => { setSubjectType('user'); setSubjectId(''); }}>
                    <UserIcon size={11} /> 成员
                  </button>
                  <button type="button" title="按角色标签批量授权（标签在成员管理里维护）" className="h-8 px-2 text-[11px] flex items-center gap-1" style={subjectType === 'label' ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)' } : { background: 'var(--bg-input)', color: 'var(--text-muted)' }} onClick={() => { setSubjectType('label'); setSubjectId(''); }}>
                    <Tag size={11} /> 标签
                  </button>
                </div>
                <select
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                  className="flex-1 h-8 px-2 rounded-[8px] text-[12px] outline-none min-w-0"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="">{subjectType === 'user' ? '选择成员…' : labelDict.length > 0 ? '选择标签…' : '暂无标签（先到成员管理给成员打标签）'}</option>
                  {subjectType === 'user'
                    ? members.map((m) => <option key={m.userId} value={m.userId}>{m.userName ?? m.userId}</option>)
                    : labelDict.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as WebPageGroupRole)}
                  className="h-8 px-2 rounded-[8px] text-[12px] outline-none shrink-0"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="viewer">可看</option>
                  <option value="editor">可编辑</option>
                </select>
                <button
                  type="button"
                  disabled={!subjectId}
                  className="h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1 shrink-0"
                  style={subjectId
                    ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }
                    : { background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)', cursor: 'not-allowed' }}
                  onClick={addRule}
                >
                  <Plus size={12} /> 添加
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 h-[56px]" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button type="button" className="h-8 px-3 rounded-[8px] text-[12px]" style={{ color: 'var(--text-muted)' }} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            className="h-8 px-4 rounded-[8px] text-[12px]"
            style={{ background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
