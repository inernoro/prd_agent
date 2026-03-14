import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { DailyLogPanel } from './DailyLogPanel';

interface Props {
  onClose: () => void;
}

/**
 * DailyLogInline — wraps DailyLogPanel with a back button
 * so it can be used inline within the ReportMainView
 */
export function DailyLogInline({ onClose }: Props) {
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center gap-2 px-1">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft size={15} />
        </Button>
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          返回周报
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <DailyLogPanel />
      </div>
    </div>
  );
}
