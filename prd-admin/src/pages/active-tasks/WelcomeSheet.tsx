/**
 * 第一次打开任务台时的那一屏 —— 只出现一次。
 *
 * 刻意不做逐步高亮的产品导览：苹果第一方 App 一个都没有。它们做的是三件别的事 ——
 * 一屏式的「新功能介绍」、示例数据、以及让界面自己教（圆圈、加号本来就是自解释的）。
 * 所以这里只说一件界面自己说不清的事：结案要留一句「做成了什么样」。
 * 其余的圆圈、加一件，不在这儿讲，用户点一下就懂。
 *
 * 看过就不再出现（存 localStorage：纯 UI 偏好、发版后用旧值无害，符合 no-localstorage 的例外清单）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Circle, PenLine, Users } from 'lucide-react';
import { TaskSheet } from './TaskSheet';

const KEY = 'atb.welcome.seen.v1';

function readSeen(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

/** 没看过就返回 true，并给一个「记下已看过」的动作 */
export function useFirstRun(ready: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (ready && !readSeen()) setOpen(true); }, [ready]);
  const dismiss = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(KEY, '1'); } catch { /* 无痕模式下记不住就每次讲一遍，不算错 */ }
  }, []);
  return [open, dismiss];
}

const LINES = [
  { Icon: Circle, title: '点圆圈就是做完了', body: '手上那件做完，下一件自己顶上来。' },
  { Icon: PenLine, title: '做完补一句「做成了什么样」', body: '一周后翻回来，看的是这句，不是一串对号。' },
  { Icon: Users, title: '别人看得到你在做什么', body: '不用再挨个说一遍。卡住了就写清在等谁。' },
];

export function WelcomeSheet({ onClose }: { onClose: () => void }) {
  return (
    <TaskSheet title="任务台" confirmLabel="开始用" cancelLabel="跳过" onConfirm={onClose} onClose={onClose}>
      <div className="atb-welcome">
        {LINES.map(({ Icon, title, body }) => (
          <div className="atb-welcome__row" key={title}>
            <Icon size={20} className="atb-welcome__icon" aria-hidden="true" />
            <div className="atb-welcome__text">
              <span className="atb-welcome__title">{title}</span>
              <span className="atb-welcome__body">{body}</span>
            </div>
          </div>
        ))}
      </div>
    </TaskSheet>
  );
}

export default WelcomeSheet;
