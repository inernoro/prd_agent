// 观测主页：外壳（header + 导航）由 ConsoleLayout 提供，本页只渲染日志主体。
import { LogsView } from '@/components/LogsView';

export function LogsPage() {
  return <LogsView />;
}
