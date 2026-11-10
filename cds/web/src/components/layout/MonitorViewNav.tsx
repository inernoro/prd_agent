import { Link, useLocation } from 'react-router-dom';
import { readStatusLocation } from '@/lib/statusHome';

const views = [
  { value: 'home', label: '监控总览' },
  { value: 'catalog', label: '监控列表' },
  { value: 'history', label: '处理记录' },
  { value: 'owner', label: '监控管理' },
] as const;

/** Monitoring subnavigation stays inside the native CDS shell on every route phase. */
export function MonitorViewNav(): JSX.Element {
  const { search } = useLocation();
  const { view } = readStatusLocation(new URLSearchParams(search));
  const active = view === 'all' ? 'owner' : view === 'detail' ? 'catalog' : view;
  return (
    <nav className="monitor-view-nav" aria-label="监控视图">
      {views.map(({ value, label }) => (
        <Link
          key={value}
          to={{ pathname: '/status', search: value === 'home' ? '' : `?view=${value}` }}
          aria-current={active === value ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
