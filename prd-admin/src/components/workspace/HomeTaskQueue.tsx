import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { getMyActiveTasks } from '@/services/real/activeTasks';
import type { MyActiveTasks } from '@/services/contracts/activeTasks';
import { useAuthStore } from '@/stores/authStore';
import { PersonAvatar } from './Workspace';

/** 只读取已有任务台；完成、分派等写操作仍在任务台进行。 */
export function HomeTaskQueue() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<MyActiveTasks>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void getMyActiveTasks()
      .then((response) => {
        if (!current) return;
        if (response.success) {
          setData(response.data);
          setError('');
        } else setError(response.error.message);
      })
      .catch(() => {
        if (current) setError('任务暂不可用');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [revision]);
  const task = data?.active;
  const queued = data?.standby ?? [];
  return (
    <section
      className="map-workspace home-task-queue"
      aria-label="我的当前任务"
    >
      <header>
        <div className="ws-person">
          <PersonAvatar
            person={{
              displayName: user?.displayName || data?.displayName || '我',
              avatarFileName: user?.avatarFileName,
              avatarUrl: user?.avatarUrl,
            }}
            size={25}
          />
          <strong>我的任务</strong>
          <span className="ws-badge">
            {loading ? '读取中' : data ? `${queued.length} 件待做` : '暂不可用'}
          </span>
        </div>
        <div className="ws-person">
          <button
            type="button"
            aria-label="刷新我的任务"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="ws-link"
            onClick={() => navigate('/active-tasks')}
          >
            任务台
            <ArrowUpRight size={13} />
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="ws-note">
          {error}
          {data ? '，仍显示上次读取的任务。' : '。'}
          <button onClick={reload}>重试</button>
        </p>
      )}
      {data && (
        <div className="home-task-grid">
          <button
            className="home-task-current"
            onClick={() => navigate('/active-tasks')}
          >
            <span className={`ws-badge ${task?.blocked ? 'warning' : ''}`}>
              {task
                ? task.blocked
                  ? '受阻'
                  : task.running
                    ? '正在进行'
                    : '当前任务'
                : '尚未开始'}
            </span>
            <strong>{task?.title || '从待做队列选一件开始'}</strong>
            <small>
              {task?.blocked
                ? task.blockedOn || task.blockedLabel
                : task?.elapsedLabel || '打开任务台安排下一步'}
            </small>
          </button>
          <div className="home-task-next">
            {queued.slice(0, 3).map((item) => (
              <button key={item.id} onClick={() => navigate('/active-tasks')}>
                <span>{item.title}</span>
                <small className={item.overdue ? 'text-semantic-red' : ''}>
                  {item.dueLabel || '未设截止时间'}
                </small>
              </button>
            ))}
            {!queued.length && <p>暂无待做任务，可在任务台添加。</p>}
          </div>
        </div>
      )}
      {!data && loading && (
        <p className="ws-note" role="status">
          正在读取任务台，其他工作可继续打开。
        </p>
      )}
    </section>
  );
}
