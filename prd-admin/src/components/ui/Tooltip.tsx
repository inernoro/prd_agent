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
              background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
              border: '1px solid var(--glass-border, rgba(255,255,255,0.14))',
              color: 'var(--text-primary)',
              boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
              backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
              maxWidth: 320,
              userSelect: 'none',
              zIndex: 1000,
            }}
          >
            {content}
            <TooltipPrimitive.Arrow
              width={10}
              height={6}
              style={{ fill: 'rgba(40, 40, 44, 0.9)' }}
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

