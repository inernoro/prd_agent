import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Users, MapPin, CalendarClock, NotebookText, ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import {
  listPmMeetings, createPmMeeting, updatePmMeeting, deletePmMeeting, getPmMembers,
} from '@/services';
import type { PmMeeting } from '@/services/contracts/pmAgent';
import type { AdminUser } from '@/types/admin';
import { mdExcerpt, fmtDateTime, relTime, filterInputCls, filterInputStyle } from './materialUtils';

interface Props {
  projectId: string;
}

type TimeRange = 'all' | 'upcoming' | 'month' | 'quarter';
type SortKey = 'time-desc' | 'time-asc';

/** ISO → datetime-local 输入值（YYYY-MM-DDTHH:mm，本地时区） */
function toLocalInput(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 项目会议纪要 — 全宽卡片列表页（关键词/时间范围/参会人/排序 筛选）+ 详情阅读 + Markdown 编辑。
 */
export function MeetingsPanel({ projectId }: Props) {
  const [meetings, setMeetings] = useState<PmMeeting[]>([]);
  // userId → 显示名（项目成员 + 选择时记录），不再预取管理员用户列表（普通用户无 users.read 权限）
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null | 'new' | id
  const [dTitle, setDTitle] = useState('');
  const [dAt, setDAt] = useState('');
  const [dLoc, setDLoc] = useState('');
  const [dAttendees, setDAttendees] = useState<string[]>([]);
  const [dContent, setDContent] = useState('');
  const [pickId, setPickId] = useState('');
  const [saving, setSaving] = useState(false);
  // 筛选
  const [q, setQ] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [attendeeFilter, setAttendeeFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time-desc');

  const load = useCallback(async () => {
    const res = await listPmMeetings(projectId);
    if (res.success) setMeetings(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    void getPmMembers(projectId).then((res) => {
      if (!res.success) return;
      setNameMap((prev) => {
        const next = new Map(prev);
        for (const m of [...res.data.members, ...res.data.observers]) next.set(m.userId, m.displayName || m.userId);
        return next;
      });
    });
  }, [projectId]);

  const nameOf = (uid: string) => nameMap.get(uid) || uid;
  const selected = meetings.find((m) => m.id === selectedId) || null;

  const attendees = useMemo(() => {
    const s = new Set<string>();
    for (const m of meetings) (m.attendeeIds || []).forEach((id) => s.add(id));
    return [...s];
  }, [meetings]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const monthAgo = now - 30 * 86400000;
    const quarterAgo = now - 90 * 86400000;
    let list = meetings.filter((m) => {
      if (attendeeFilter && !(m.attendeeIds || []).includes(attendeeFilter)) return false;
      if (timeRange !== 'all') {
        const t = m.meetingAt ? new Date(m.meetingAt).getTime() : null;
        if (timeRange === 'upcoming') { if (t == null || t < now) return false; }
        else if (timeRange === 'month') { if (t == null || t < monthAgo) return false; }
        else if (timeRange === 'quarter') { if (t == null || t < quarterAgo) return false; }
      }
      if (q.trim()) {
        const k = q.trim().toLowerCase();
        if (!(`${m.title} ${m.content} ${m.location ?? ''}`.toLowerCase().includes(k))) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      const at = a.meetingAt ? new Date(a.meetingAt).getTime() : new Date(a.createdAt).getTime();
      const bt = b.meetingAt ? new Date(b.meetingAt).getTime() : new Date(b.createdAt).getTime();
      return sortKey === 'time-asc' ? at - bt : bt - at;
    });
    return list;
  }, [meetings, q, timeRange, attendeeFilter, sortKey]);

  const startCreate = () => { setEditing('new'); setDTitle(''); setDAt(''); setDLoc(''); setDAttendees([]); setDContent(''); };
  const startEdit = (m: PmMeeting) => {
    setEditing(m.id); setDTitle(m.title); setDAt(toLocalInput(m.meetingAt)); setDLoc(m.location || ''); setDAttendees(m.attendeeIds || []); setDContent(m.content);
  };
  const cancelEdit = () => setEditing(null);
  const openDetail = (id: string) => { setEditing(null); setSelectedId(id); setMode('detail'); };
  const backToList = () => { setEditing(null); setMode('list'); };

  const addAttendee = (u: AdminUser) => {
    setPickId('');
    setNameMap((prev) => new Map(prev).set(u.userId, u.displayName || u.username || u.userId));
    if (u.userId && !dAttendees.includes(u.userId)) setDAttendees((p) => [...p, u.userId]);
  };
  const removeAttendee = (uid: string) => setDAttendees((p) => p.filter((x) => x !== uid));

  const saveDraft = async () => {
    if (!dTitle.trim()) { toast.error('请填写会议主题', ''); return; }
    setSaving(true);
    const payload = { title: dTitle.trim(), meetingAt: dAt || undefined, location: dLoc.trim() || undefined, attendeeIds: dAttendees, content: dContent };
    if (editing === 'new') {
      const res = await createPmMeeting(projectId, payload);
      if (res.success) { toast.success('已创建', ''); setEditing(null); setSelectedId(res.data.id); setMode('detail'); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else if (editing) {
      const res = await updatePmMeeting(editing, payload);
      if (res.success) { toast.success('已保存', ''); setEditing(null); setMode('detail'); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setSaving(false);
  };

  const handleDelete = async (m: PmMeeting) => {
    if (!window.confirm(`确定删除会议纪要「${m.title}」？`)) return;
    const res = await deletePmMeeting(m.id);
    if (res.success) { setMeetings((prev) => prev.filter((x) => x.id !== m.id)); if (selectedId === m.id) { setSelectedId(null); setMode('list'); } }
    else toast.error('删除失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载会议纪要…" /></div>;

  // ───────── 编辑视图 ─────────
  if (editing !== null) {
    return (
      <div className="flex-1 min-h-0 flex flex-col rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
          <NotebookText size={15} style={{ color: '#A855F7' }} />
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
          <div style={{ width: 200 }}><UserSearchSelect value={pickId} onChange={() => {}} onSelectUser={addAttendee} placeholder="添加参会人…" uiSize="sm" /></div>
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
    );
  }

  // ───────── 详情视图 ─────────
  if (mode === 'detail' && selected) {
    const m = selected;
    return (
      <div className="flex-1 min-h-0 flex flex-col rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-start gap-2 px-4 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Button variant="ghost" size="sm" onClick={backToList}><ArrowLeft size={14} />返回列表</Button>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{m.title}</div>
            <div className="flex items-center gap-3 mt-1 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {m.meetingAt && <span className="inline-flex items-center gap-1"><CalendarClock size={11} />{fmtDateTime(m.meetingAt)}</span>}
              {m.location && <span className="inline-flex items-center gap-1"><MapPin size={11} />{m.location}</span>}
              <span className="inline-flex items-center gap-1"><Users size={11} />{m.attendeeIds.length ? m.attendeeIds.map(nameOf).join('、') : '未记录参会人'}</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => startEdit(m)}><Pencil size={13} />编辑</Button>
          <Button variant="ghost" size="sm" onClick={() => handleDelete(m)}><Trash2 size={13} />删除</Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5" style={{ overscrollBehavior: 'contain' }}>
          {m.content.trim() ? <MarkdownContent content={m.content} variant="reading" /> : <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>本会议暂无纪要内容，点「编辑」补充</div>}
        </div>
      </div>
    );
  }

  // ───────── 列表视图（全宽卡片 + 筛选） ─────────
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <NotebookText size={15} style={{ color: '#A855F7' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>会议纪要</span>
          <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{filtered.length}/{meetings.length}</span>
          <Button variant="primary" size="sm" className="ml-auto" onClick={startCreate}><Plus size={13} />新建会议</Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={13} style={{ color: 'var(--text-muted)', position: 'absolute', left: 8, top: 8 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索主题 / 纪要 / 地点"
              className={`${filterInputCls} pl-7`} style={{ ...filterInputStyle, width: 220 }} />
          </div>
          <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)} className={filterInputCls} style={filterInputStyle} title="时间范围">
            <option value="all">全部时间</option>
            <option value="upcoming">即将召开</option>
            <option value="month">近 30 天</option>
            <option value="quarter">近 90 天</option>
          </select>
          <select value={attendeeFilter} onChange={(e) => setAttendeeFilter(e.target.value)} className={filterInputCls} style={filterInputStyle} title="参会人">
            <option value="">全部参会人</option>
            {attendees.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
          </select>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={filterInputCls} style={filterInputStyle} title="排序">
            <option value="time-desc">时间（新→旧）</option>
            <option value="time-asc">时间（旧→新）</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
            <NotebookText size={32} style={{ opacity: 0.4 }} />
            <div className="text-[12.5px]">{meetings.length === 0 ? '还没有会议纪要，点「新建会议」' : '没有符合筛选条件的会议'}</div>
          </div>
        ) : (
          <div className="grid gap-3 pb-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {filtered.map((m) => (
              <button key={m.id} onClick={() => openDetail(m.id)}
                className="group text-left rounded-xl border p-3.5 flex flex-col gap-2 transition-colors hover:border-[var(--border-strong)]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 w-7 h-7 rounded-lg shrink-0 flex items-center justify-center" style={{ background: 'rgba(168,85,247,0.12)' }}>
                    <NotebookText size={14} style={{ color: '#A855F7' }} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-semibold leading-snug line-clamp-2" style={{ color: 'var(--text-primary)' }}>{m.title}</div>
                    <div className="text-[11px] mt-0.5 truncate inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      {m.meetingAt ? <><CalendarClock size={10} />{fmtDateTime(m.meetingAt)}</> : '未排期'}
                    </div>
                  </div>
                </div>
                <div className="text-[11.5px] leading-relaxed line-clamp-3 min-h-[3em]" style={{ color: 'var(--text-secondary)' }}>
                  {mdExcerpt(m.content) || '（暂无纪要内容）'}
                </div>
                <div className="flex items-center gap-2 flex-wrap mt-auto pt-1 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  {m.location && <span className="inline-flex items-center gap-1 truncate max-w-[140px]"><MapPin size={10} />{m.location}</span>}
                  <span className="inline-flex items-center gap-1"><Users size={10} />{m.attendeeIds.length} 人</span>
                  <span className="ml-auto">{relTime(m.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
