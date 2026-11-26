import { useId } from 'react';
import { Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AGENT_KEY_EXPIRY_DAYS, type AgentKeyExpiryDays } from '../../../src/shared/project-agent-key';

export function AgentKeyExpiryPicker({ value, onChange, disabled }: {
  value?: AgentKeyExpiryDays;
  onChange: (days?: AgentKeyExpiryDays) => void;
  disabled: boolean;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="space-y-2 rounded-lg border border-border bg-background px-3 pb-3 pt-1">
      <legend className="px-1 text-sm font-medium">
        <Clock3 className="mr-1 inline size-4 align-text-bottom text-muted-foreground" aria-hidden="true" />有效期
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {[undefined, ...AGENT_KEY_EXPIRY_DAYS].map(days => (
          <label key={days ?? 'permanent'} className={cn(
            'cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
            value === days ? 'border-primary bg-primary-soft/40 text-primary-ink' : 'border-border text-muted-foreground',
          )}>
            <input type="radio" name={name} className="sr-only" checked={value === days} onChange={() => onChange(days)} />
            {days === undefined ? '永久' : `${days} 天`}
          </label>
        ))}
      </div>
      {value !== undefined && <p className="text-xs text-muted-foreground">签发 {value} 天后自动失效。</p>}
    </fieldset>
  );
}
