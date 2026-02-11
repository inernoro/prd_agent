import { useState, useCallback, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { HexColorPicker } from 'react-colorful';
import { glassPopoverCompact } from '@/lib/glassStyles';

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
  title?: string;
};

export function ColorPicker({ value, onChange, title }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value.replace('#', '').toUpperCase());

  // Sync inputValue when value prop changes externally
  useEffect(() => {
    setInputValue(value.replace('#', '').toUpperCase());
  }, [value]);

  const handleColorChange = useCallback((color: string) => {
    setInputValue(color.replace('#', '').toUpperCase());
    onChange(color);
  }, [onChange]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace('#', '').toUpperCase();
    setInputValue(val);
    // Validate hex color format (6 chars)
    if (/^[0-9A-F]{6}$/.test(val)) {
      onChange('#' + val);
    }
  }, [onChange]);

  const handleInputBlur = useCallback(() => {
    // Reset to current value if invalid
    if (!/^[0-9A-F]{6}$/.test(inputValue)) {
      setInputValue(value.replace('#', '').toUpperCase());
    }
  }, [inputValue, value]);

  return (
    <div
      className="h-8 flex items-center gap-1.5 px-1.5 rounded-lg"
      style={{
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="h-5 w-5 rounded-[3px] cursor-pointer transition-transform hover:scale-105 shrink-0"
            style={{
              background: value,
              border: '1px solid rgba(255,255,255,0.2)',
            }}
            title={title}
          />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="rounded-xl p-3 shadow-xl"
            style={{
              ...glassPopoverCompact,
              zIndex: 9999,
            }}
            sideOffset={8}
            align="start"
          >
            <HexColorPicker
              color={value}
              onChange={handleColorChange}
              style={{ width: '200px', height: '160px' }}
            />
            <Popover.Arrow
              style={{ fill: 'rgba(30, 30, 35, 0.95)' }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        className="w-14 h-6 bg-transparent text-[11px] font-mono uppercase outline-none"
        style={{
          color: 'rgba(255,255,255,0.85)',
        }}
        maxLength={6}
        placeholder="FFFFFF"
      />
    </div>
  );
}
