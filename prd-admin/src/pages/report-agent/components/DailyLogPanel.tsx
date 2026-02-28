import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Save, ChevronLeft, ChevronRight, Clock, Calendar } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import {
  saveDailyLog,
  getDailyLog,
  deleteDailyLog,
  listDailyLogs,
} from '@/services';
import {
  DailyLogCategory,
  DailyLogCategoryLabels,
} from '@/services/contracts/reportAgent';
import type { DailyLog, DailyLogItem } from '@/services/contracts/reportAgent';

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const categoryOptions = Object.entries(DailyLogCategoryLabels).map(([value, label]) => ({
  value,
  label,
}));

interface LogItemInput {
  content: string;
  category: string;
  durationMinutes: number | undefined;
}

export function DailyLogPanel() {
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [items, setItems] = useState<LogItemInput[]>([
    { content: '', category: DailyLogCategory.Development, durationMinutes: undefined },
  ]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [existingLog, setExistingLog] = useState<DailyLog | null>(null);
  const [weekLogs, setWeekLogs] = useState<DailyLog[]>([]);

  // Load logs for current week sidebar
  const loadWeekLogs = useCallback(async () => {
    const d = parseDate(selectedDate);
    const dayOfWeek = d.getDay() || 7; // Monday=1
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const res = await listDailyLogs({
      startDate: formatDate(monday),
      endDate: formatDate(sunday),
    });
    if (res.success && res.data) {
      setWeekLogs(res.data.items);
    }
  }, [selectedDate]);

  // Load log for selected date
  const loadLog = useCallback(async () => {
    setLoaded(false);
    const res = await getDailyLog({ date: selectedDate });
    if (res.success && res.data) {
      setExistingLog(res.data);
      setItems(
        res.data.items.map((i: DailyLogItem) => ({
          content: i.content,
          category: i.category,
          durationMinutes: i.durationMinutes,
        }))
      );
    } else {
      setExistingLog(null);
      setItems([{ content: '', category: DailyLogCategory.Development, durationMinutes: undefined }]);
    }
    setLoaded(true);
  }, [selectedDate]);

  useEffect(() => {
    void loadLog();
    void loadWeekLogs();
  }, [loadLog, loadWeekLogs]);

  const handleSave = async () => {
    const validItems = items.filter((i) => i.content.trim());
    if (validItems.length === 0) {
      toast.error('请至少填写一条工作记录');
      return;
    }
    setSaving(true);
    const res = await saveDailyLog({
      date: selectedDate,
      items: validItems.map((i) => ({
        content: i.content.trim(),
        category: i.category,
        durationMinutes: i.durationMinutes,
      })),
    });
    setSaving(false);
    if (res.success) {
      toast.success('已保存');
      setExistingLog(res.data ?? null);
      void loadWeekLogs();
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  };

  const handleDelete = async () => {
    if (!existingLog) return;
    if (!window.confirm('确认删除该日志？')) return;
    const res = await deleteDailyLog({ date: selectedDate });
    if (res.success) {
      toast.success('已删除');
      setExistingLog(null);
      setItems([{ content: '', category: DailyLogCategory.Development, durationMinutes: undefined }]);
      void loadWeekLogs();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const addItem = () => {
    setItems((prev) => [...prev, { content: '', category: DailyLogCategory.Development, durationMinutes: undefined }]);
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: keyof LogItemInput, value: string | number | undefined) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const navigateDate = (offset: number) => {
    const d = parseDate(selectedDate);
    d.setDate(d.getDate() + offset);
    setSelectedDate(formatDate(d));
  };

  const totalMinutes = items.reduce((sum, i) => sum + (i.durationMinutes || 0), 0);

  // Days of the week that have logs
  const loggedDates = new Set(weekLogs.map((l) => l.date.substring(0, 10)));

  return (
    <div className="flex flex-col gap-4">
      {/* Date navigation */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={() => navigateDate(-1)}>
              <ChevronLeft size={14} />
            </Button>
            <input
              type="date"
              className="px-2 py-1 rounded text-[13px]"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
            <Button variant="ghost" size="sm" onClick={() => navigateDate(1)}>
              <ChevronRight size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedDate(formatDate(new Date()))}>
              今天
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {existingLog && (
              <Button variant="ghost" size="sm" onClick={handleDelete}>
                <Trash2 size={12} /> 删除
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              <Save size={12} /> {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </GlassCard>

      <div className="flex gap-4">
        {/* Main editor */}
        <div className="flex-1 flex flex-col gap-3">
          {!loaded ? (
            <GlassCard className="p-8 text-center">
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            </GlassCard>
          ) : (
            <>
              {items.map((item, idx) => (
                <GlassCard key={idx} className="p-3">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <select
                        className="px-2 py-1.5 rounded text-[12px]"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                        value={item.category}
                        onChange={(e) => updateItem(idx, 'category', e.target.value)}
                      >
                        {categoryOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        <Clock size={12} style={{ color: 'var(--text-muted)' }} />
                        <input
                          type="number"
                          className="w-16 px-2 py-1.5 rounded text-[12px]"
                          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                          placeholder="分钟"
                          value={item.durationMinutes ?? ''}
                          min={0}
                          onChange={(e) => updateItem(idx, 'durationMinutes', e.target.value ? Number(e.target.value) : undefined)}
                        />
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>分钟</span>
                      </div>
                      <div className="flex-1" />
                      {items.length > 1 && (
                        <Button variant="ghost" size="sm" onClick={() => removeItem(idx)}>
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                    <textarea
                      className="w-full px-3 py-2 rounded-lg text-[13px] resize-none"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 60 }}
                      placeholder="记录今天的工作内容..."
                      value={item.content}
                      onChange={(e) => updateItem(idx, 'content', e.target.value)}
                    />
                  </div>
                </GlassCard>
              ))}
              <Button variant="ghost" size="sm" className="self-start" onClick={addItem}>
                <Plus size={12} /> 添加一条
              </Button>
            </>
          )}
        </div>

        {/* Week sidebar */}
        <div className="w-48 flex-shrink-0">
          <GlassCard variant="subtle" className="p-3">
            <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              本周概览
            </div>
            <div className="flex flex-col gap-1.5">
              {['一', '二', '三', '四', '五', '六', '日'].map((label, i) => {
                const d = parseDate(selectedDate);
                const dayOfWeek = d.getDay() || 7;
                const monday = new Date(d);
                monday.setDate(d.getDate() - dayOfWeek + 1);
                const dayDate = new Date(monday);
                dayDate.setDate(monday.getDate() + i);
                const dateStr = formatDate(dayDate);
                const hasLog = loggedDates.has(dateStr);
                const isSelected = dateStr === selectedDate;
                const isToday = dateStr === formatDate(new Date());

                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] transition-colors"
                    style={{
                      background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                    onClick={() => setSelectedDate(dateStr)}
                  >
                    <span className="w-5">周{label}</span>
                    <span className="flex-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {dayDate.getMonth() + 1}/{dayDate.getDate()}
                    </span>
                    {isToday && (
                      <span className="text-[9px] px-1 rounded" style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.1)' }}>今</span>
                    )}
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: hasLog ? 'rgba(34, 197, 94, 0.8)' : 'var(--border-primary)',
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {totalMinutes > 0 && (
              <div className="mt-3 pt-3 text-[11px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-primary)' }}>
                今日已记录: {Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m
              </div>
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
