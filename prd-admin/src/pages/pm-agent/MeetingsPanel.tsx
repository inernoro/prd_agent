import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Users, MapPin, CalendarClock, NotebookText } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import {
  listPmMeetings, createPmMeeting, updatePmMeeting, deletePmMeeting, getUsers,
} from '@/services';
import type { PmMeeting } from '@/services/contracts/pmAgent';
import type { AdminUser } from '@/types/admin';

interface Props {
  projectId: string;
}

function fmtDateTime(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** ISO → datetime-local 输入值（YYYY-MM-DDTHH:mm，本地时区） */
function toLocalInput(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 项目会议纪要 — 左列会议列表 + 右侧纪要阅读/编辑（参会人多选 + Markdown 正文）。
 */
export function MeetingsPanel({ projectId }: Props) {
  const [meetings, setMeetings] = useState<PmMeeting[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null | 'new' | id
  const [dTitle, setDTitle] = useState('');
  const [dAt, setDAt] = useState('');
  const [dLoc, setDLoc] = useState('');
  const [dAttendees, setDAttendees] = useState<string[]>([]);
  const [dContent, setDContent] = useState('');
  const [pickId, setPickId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await listPmMeetings(projectId);
    if (res.success) { setMeetings(res.data.items); setSelectedId((cur) => cur ?? res.data.items[0]?.id ?? null); }
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    void getUsers({ page: 1, pageSize: 200 }).then((res) => { if (res.success) setUsers(res.data.items.filter((u) => u.status === 'Active')); });
  }, []);

  const nameOf = (uid: string) => users.find((u) => u.userId === uid)?.displayName || uid;
  const selected = meetings.find((m) => m.id === selectedId) || null;

  const startCreate = () => { setEditing('new'); setDTitle(''); setDAt(''); setDLoc(''); setDAttendees([]); setDContent(''); };
  const startEdit = (m: PmMeeting) => {
    setEditing(m.id); setDTitle(m.title); setDAt(toLocalInput(m.meetingAt)); setDLoc(m.location || ''); setDAttendees(m.attendeeIds || []); setDContent(m.content);
  };
  const cancelEdit = () => setEditing(null);

  const addAttendee = (uid: string) => { setPickId(''); if (uid && !dAttendees.includes(uid)) setDAttendees((p) => [...p, uid]); };
  const removeAttendee = (uid: string) => setDAttendees((p) => p.filter((x) => x !== uid));

  const saveDraft = async () => {
    if (!dTitle.trim()) { toast.error('请填写会议主题', ''); return; }
    setSaving(true);
    const payload = { title: dTitle.trim(), meetingAt: dAt || undefined, location: dLoc.trim() || undefined, attendeeIds: dAttendees, content: dContent };
    if (editing === 'new') {
      const res = await createPmMeeting(projectId, payload);
      if (res.success) { toast.success('已创建', ''); setEditing(null); setSelectedId(res.data.id); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else if (editing) {
      const res = await updatePmMeeting(editing, payload);
      if (res.success) { toast.success('已保存', ''); setEditing(null); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setSaving(false);
  };

  const handleDelete = async (m: PmMeeting) => {
    if (!window.confirm(`确定删除会议纪要「${m.title}」？`)) return;
    const res = await deletePmMeeting(m.id);
    if (res.success) { setMeetings((prev) => prev.filter((x) => x.id !== m.id)); if (selectedId === m.id) setSelectedId(null); }
    else toast.error('删除失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载会议纪要…" /></div>;

  const inEditor = editing !== null;

  return (
    <div className="flex-1 min-h-0 flex gap-3">
      {/* 左列：会议列表 */}
      <div className="w-[256px] shrink-0 flex flex-col min-h-0 rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-center gap-1.5 px-3 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <NotebookText size={14} style={{ color: '#A855F7' }} />
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>会议纪要</span>
          <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{meetings.length}</span>
          <button onClick={startCreate} className="ml-auto p-1 rounded hover:opacity-80" title="新建会议" style={{ color: '#A855F7' }}><Plus size={15} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1" style={{ overscrollBehavior: 'contain' }}>
          {meetings.length === 0 ? (
            <div className="text-[11px] text-center py-8" style={{ color: 'var(--text-muted)' }}>还没有会议纪要，点右上「+」新建</div>
          ) : meetings.map((m) => {
            const active = selectedId === m.id && !inEditor;
            return (
              <button key={m.id} onClick={() => { setEditing(null); setSelectedId(m.id); }}
                className="text-left rounded-lg px-2.5 py-2 border" title={m.title}
                style={{ borderColor: active ? '#A855F7' : 'transparent', background: active ? 'rgba(168,85,247,0.12)' : 'var(--bg-elevated)' }}>
                <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.title}</div>
                <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                  {m.meetingAt ? `${fmtDateTime(m.meetingAt)} · ` : ''}{m.attendeeIds.length} 人参会
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧：阅读 / 编辑 */}
      <div className="flex-1 min-h-0 flex flex-col rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        {inEditor ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
              <input value={dTitle} onChange={(e) => setDTitle(e.target.value)} placeholder="会议主题"
                className="flex-1 min-w-[160px] text-[13px] rounded-md px-2.5 py-1.5 outline-none border"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <input type="datetime-local" value={dAt} onChange={(e) => setDAt(e.target.value)} title="会议时间"
                className="text-[12px] rounded-md px-2 py-1.5 outline-none border"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={cancelEdit}><X size={13} />取消</Button>
                <Button variant="primary" size="sm" onClick={saveDraft} disabled={saving}>{saving ? <MapSpinner size={13} /> : <Check size={13} />}保存</Button>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
              <MapPin size={13} style={{ color: 'var(--text-muted)' }} />
              <input value={dLoc} onChange={(e) => setDLoc(e.target.value)} placeholder="会议地点 / 线上链接"
                className="text-[12px] rounded-md px-2 py-1 outline-none border" style={{ width: 220, background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <Users size={13} style={{ color: 'var(--text-muted)' }} />
              <div style={{ width: 200 }}><UserSearchSelect value={pickId} onChange={addAttendee} users={users} placeholder="添加参会人…" uiSize="sm" /></div>
              <div className="flex items-center gap-1 flex-wrap">
                {dAttendees.map((uid) => (
                  <span key={uid} className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
                    {nameOf(uid)}<button onClick={() => removeAttendee(uid)} style={{ color: 'var(--text-muted)' }}><X size={10} /></button>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0 flex">
              <textarea value={dContent} onChange={(e) => setDContent(e.target.value)} placeholder="在此编写会议纪要（Markdown）…"
                className="flex-1 min-h-0 resize-none outline-none px-4 py-3 text-[13px] font-mono leading-relaxed border-r"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
                {dContent.trim() ? <MarkdownContent content={dContent} variant="reading" /> : <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>预览区 — 左侧输入 Markdown 实时渲染</div>}
              </div>
            </div>
          </div>
        ) : selected ? (
          <>
            <div className="flex items-start gap-2 px-4 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{selected.title}</div>
                <div className="flex items-center gap-3 mt-1 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {selected.meetingAt && <span className="inline-flex items-center gap-1"><CalendarClock size={11} />{fmtDateTime(selected.meetingAt)}</span>}
                  {selected.location && <span className="inline-flex items-center gap-1"><MapPin size={11} />{selected.location}</span>}
                  <span className="inline-flex items-center gap-1"><Users size={11} />{selected.attendeeIds.length ? selected.attendeeIds.map(nameOf).join('、') : '未记录参会人'}</span>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => startEdit(selected)}><Pencil size={13} />编辑</Button>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(selected)}><Trash2 size={13} />删除</Button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5" style={{ overscrollBehavior: 'contain' }}>
              {selected.content.trim() ? <MarkdownContent content={selected.content} variant="reading" /> : <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>本会议暂无纪要内容，点「编辑」补充</div>}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
            <NotebookText size={32} style={{ opacity: 0.4 }} />
            <div className="text-[12px]">从左侧选择一篇会议纪要查看，或点「+」新建</div>
          </div>
        )}
      </div>
    </div>
  );
}
