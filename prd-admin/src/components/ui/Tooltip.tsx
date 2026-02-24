import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import React, { useState } from 'react';
import { glassTooltip } from '@/lib/glassStyles';

export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  delayDuration = 180,
  openOnClick = false,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  openOnClick?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Use a div wrapper to ensure a single child for Slot, and handle click events
  const triggerContent = (
    <div
      className="inline-flex cursor-pointer"
      onClick={(e) => {
        if (openOnClick) {
          e.stopPropagation();
          e.preventDefault();
          setOpen((prev) => !prev);
        }
      }}
    >
      {children}
    </div>
  );

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root 
        open={openOnClick ? open : undefined} 
        onOpenChange={openOnClick ? setOpen : undefined}
      >
        <TooltipPrimitive.Trigger asChild>
          {triggerContent}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={8}
          alignOffset={-6}
          className="rounded-[12px] px-3 py-2 text-xs"
          style={{
            ...glassTooltip,
            color: 'rgba(255,255,255,0.95)',
            maxWidth: 240,
            userSelect: 'none',
            zIndex: 9999,
            animation: 'tooltipFloat 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
            fontWeight: 500,
            lineHeight: 1.4,
          }}
        >
          {content}
          <TooltipPrimitive.Arrow
            width={12}
            height={6}
            style={{ fill: 'rgba(20, 20, 24, 0.95)' }}
          />
        </TooltipPrimitive.Content>
        <style>{`
          @keyframes tooltipFloat {
            0% { opacity: 0; transform: translateY(4px) scale(0.96); }
            100% { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
