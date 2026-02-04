import { useState, useCallback, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { HexColorPicker } from 'react-colorful';

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
  title?: string;
};

export function ColorPicker({ value, onChange, title }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);

  // Sync inputValue when value prop changes externally
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const handleColorChange = useCallback((color: string) => {
    setInputValue(color);
    onChange(color);
  }, [onChange]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    // Validate hex color format
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      onChange(val);
    }
  }, [onChange]);

  const handleInputBlur = useCallback(() => {
    // Reset to current value if invalid
    if (!/^#[0-9A-Fa-f]{6}$/.test(inputValue)) {
      setInputValue(value);
    }
  }, [inputValue, value]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="h-6 w-6 rounded-[4px] cursor-pointer transition-transform hover:scale-105"
          style={{
            background: value,
            border: '1px solid rgba(255,255,255,0.25)',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)',
          }}
          title={title}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="rounded-xl p-3 shadow-xl"
          style={{
            background: 'rgba(30, 30, 35, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.1)',
            zIndex: 9999,
          }}
          sideOffset={8}
          align="start"
        >
          <div className="flex flex-col gap-3">
            <HexColorPicker
              color={value}
              onChange={handleColorChange}
              style={{ width: '200px', height: '160px' }}
            />
            <div className="flex items-center gap-2">
              <div
                className="h-7 w-7 rounded-[4px] shrink-0"
                style={{
                  background: value,
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
              />
              <input
                type="text"
                value={inputValue.toUpperCase().replace('#', '')}
                onChange={(e) => {
                  const val = '#' + e.target.value.replace('#', '');
                  setInputValue(val);
                  if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                    onChange(val);
                  }
                }}
                onBlur={handleInputBlur}
                className="flex-1 h-7 rounded-[4px] px-2 text-xs font-mono uppercase outline-none"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.9)',
                }}
                maxLength={6}
                placeholder="FFFFFF"
              />
            </div>
          </div>
          <Popover.Arrow
            style={{ fill: 'rgba(30, 30, 35, 0.95)' }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
