/**
 * 看板设置 —— 匿名那一屏给不给看、给看到什么程度，以及两条阈值。
 *
 * 这块面板是补上来的：后端 `GET/PUT /admin/settings` 早就在了，前端封装也写了，
 * 但没有任何一处调用它。于是「三档可见性、可以整个关掉」这句承诺只兑现了后端那一半——
 * 管理员既关不掉它，也改不了档位，只能去打接口。链路只建一半不会报错，
 * 页面照常渲染、测试照常绿，只有真去找这个开关的人会发现它不存在。
 *
 * 匿名开关默认是关的（见 `ActiveTaskBoardSettings.AnonymousEnabled`）：这一屏对着的是
 * 不需要登录的任何人，端出去的是同事真名与此刻在做什么，安全默认只能是关。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { getBoardSettings, saveBoardSettings } from '@/services/real/activeTasks';
import type { ActiveTaskBoardSettings } from '@/services/contracts/activeTasks';
import { TaskSheet } from './TaskSheet';

export interface BoardSettingsSheetProps {
  onClose: () => void;
  /** 保存成功后让外面重新拉一次：两条阈值会改变这一屏谁被标红 */
  onSaved: () => void;
}

/** 三档可见粒度。文案写「匿名的人能看到什么」，不写枚举名 */
const MODES: { value: ActiveTaskBoardSettings['anonymousMode']; label: string; hint: string }[] = [
  { value: 'masked', label: '脱敏', hint: '看得到谁在忙、谁卡住、投入多久，看不到任务写的是什么' },
  { value: 'full', label: '全文', hint: '任务标题原文照出，包括客户名、项目代号、缺陷编号' },
  { value: 'headline', label: '只给一句', hint: '只有「N 个人在推进」这一句结论，没有人名也没有任务' },
];

export function BoardSettingsSheet({ onClose, onSaved }: BoardSettingsSheetProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ActiveTaskBoardSettings['anonymousMode']>('masked');
  const [escalate, setEscalate] = useState(120);
  const [heavy, setHeavy] = useState(8);

  useEffect(() => {
    void (async () => {
      const res = await getBoardSettings();
      if (res.success && res.data) {
        setEnabled(res.data.anonymousEnabled);
        setMode(res.data.anonymousMode);
        setEscalate(res.data.blockedEscalateMinutes);
        setHeavy(res.data.heavyStackThreshold);
      } else {
        toast.error(res.error?.message ?? '读设置失败');
      }
      setLoading(false);
    })();
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    const res = await saveBoardSettings({
      anonymousEnabled: enabled,
      anonymousMode: mode,
      // 后端各自 Clamp 到 5–1440 与 2–50，这里只挡住空值与非数字
      blockedEscalateMinutes: Number.isFinite(escalate) ? escalate : undefined,
      heavyStackThreshold: Number.isFinite(heavy) ? heavy : undefined,
    });
    setSaving(false);
    if (!res.success) { toast.error(res.error?.message ?? '保存失败'); return; }
    toast.success(enabled ? '存好了，匿名那一屏现在是开的' : '存好了，匿名那一屏是关的');
    onSaved();
    onClose();
  }, [enabled, mode, escalate, heavy, onSaved, onClose]);

  return (
    <TaskSheet
      title="看板设置"
      confirmLabel="存好"
      confirmDisabled={loading || saving}
      onConfirm={() => void onSave()}
      onClose={() => { if (saving) { toast.error('正在保存，先等一下'); return; } onClose(); }}
    >
      {loading ? (
        <div className="atb-empty">读设置中…</div>
      ) : (
        <>
          <label className="atb-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>开放匿名看板</span>
          </label>
          <span className="atb-sheet__hint">
            {enabled
              ? '开着：拿到地址的任何人都不用登录就能打开 /board/active-tasks，看到下面这一档的内容。'
              : '关着：公开地址直接 404，只有登录的人看得到这一屏。'}
          </span>

          {enabled && (
            <>
              <span className="atb-sheet__hint">匿名的人能看到什么</span>
              {MODES.map((m) => (
                <label className="atb-check" key={m.value}>
                  <input
                    type="radio"
                    name="atb-anon-mode"
                    checked={mode === m.value}
                    onChange={() => setMode(m.value)}
                  />
                  <span>{m.label} —— {m.hint}</span>
                </label>
              ))}
            </>
          )}

          <span className="atb-sheet__hint">卡住多久算「要你出手」（分钟，5–1440）</span>
          <input
            className="atb-input"
            type="number"
            min={5}
            max={1440}
            aria-label="卡住多久算要你出手"
            value={escalate}
            onChange={(e) => setEscalate(Number(e.target.value))}
          />

          <span className="atb-sheet__hint">堆到几件算「堆太多」（2–50）</span>
          <input
            className="atb-input"
            type="number"
            min={2}
            max={50}
            aria-label="堆到几件算堆太多"
            value={heavy}
            onChange={(e) => setHeavy(Number(e.target.value))}
          />
        </>
      )}
    </TaskSheet>
  );
}

export default BoardSettingsSheet;
