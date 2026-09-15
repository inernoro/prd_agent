/**
 * 任务台的外壳 —— 桌面两栏、手机单栏。
 *
 * 上一版两端共用一个 640px 居中列，桌面就是一部被放大的手机：三个页面各是一次整页跳转，
 * 「做成了什么」甚至没有任何入口，只能手敲地址栏。
 *
 * macOS 上提醒事项 / 邮件 / 备忘录没有一个是单列居中，左边都有一条 source list —— 那条边栏
 * 装的正好就是这里被拆成三个路由的东西。手机上没有边栏的位置，换成顶部一条分段控件。
 */
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { useIsMobile } from '@/hooks/useBreakpoint';
import './activeTasks.css';

interface Source {
  path: string;
  label: string;
  /** 手机端分段控件里用的短标签 */
  short: string;
  permission?: string;
}

const SOURCES: Source[] = [
  { path: '/active-tasks', label: '我的任务', short: '我的' },
  { path: '/active-tasks/team', label: '大家在做什么', short: '大家', permission: 'active-tasks.manage' },
  { path: '/active-tasks/history', label: '做成了什么', short: '做成了' },
];

export interface TaskShellProps {
  title: string;
  /** 标题右边的东西：人名、时间范围、派一件 */
  trailing?: React.ReactNode;
  /** 标题下面那行结论 */
  headline?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}

export function TaskShell({ title, trailing, headline, wide, children }: TaskShellProps) {
  const isMobile = useIsMobile();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const perms = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  const sources = useMemo(
    () => SOURCES.filter((s) => !s.permission || hasEffectivePermission(perms ?? [], s.permission, isRoot)),
    [perms, isRoot],
  );

  return (
    <div className="atb-page">
      {!isMobile && (
        <nav className="atb-sidebar" aria-label="任务台">
          {sources.map((s) => (
            <button
              key={s.path}
              className={`atb-source${pathname === s.path ? ' atb-source--on' : ''}`}
              aria-current={pathname === s.path ? 'page' : undefined}
              onClick={() => nav(s.path)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      )}

      <div className={`atb-col${wide ? ' atb-col--wide' : ''}`}>
        <div className="atb-head">
          <h1 className="atb-title">{title}</h1>
          {trailing}
        </div>

        {isMobile && sources.length > 1 && (
          <div className="atb-seg" role="tablist" aria-label="任务台">
            {sources.map((s) => (
              <button
                key={s.path}
                role="tab"
                aria-selected={pathname === s.path}
                className={`atb-seg__item${pathname === s.path ? ' atb-seg__item--on' : ''}`}
                onClick={() => nav(s.path)}
              >
                {s.short}
              </button>
            ))}
          </div>
        )}

        {headline && <span className="atb-group-label">{headline}</span>}
        {children}
      </div>
    </div>
  );
}

export default TaskShell;
