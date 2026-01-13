import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  delayDuration = 180,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={10}
            className="rounded-[12px] px-3 py-2 text-xs"
            style={{
              background: 'rgba(15, 15, 18, 1)',
              border: '1px solid rgba(255,255,255,0.14)',
              color: 'var(--text-primary)',
              boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
              maxWidth: 320,
              userSelect: 'none',
              zIndex: 1000,
            }}
          >
            {content}
            <TooltipPrimitive.Arrow
              width={10}
              height={6}
              style={{ fill: 'rgba(15, 15, 18, 1)' }}
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

