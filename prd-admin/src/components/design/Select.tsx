import * as SelectPrimitive from '@radix-ui/react-select';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import {
  selectContentClass,
  selectContentStyle,
  selectItemClass,
  selectLabelClass,
  selectTriggerClass,
  selectTriggerStyle,
  selectViewportClass,
  selectViewportStyle,
} from './selectStyles';

export const Select = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
    value?: string | number;
    defaultValue?: string | number;
    onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    name?: string;
    required?: boolean;
    /** 仅用于调整整体高度（与 Button 的尺寸体系对齐） */
    uiSize?: 'sm' | 'md';
    /** 左侧图标 */
    leftIcon?: React.ReactNode;
    children?: React.ReactNode;
  }
>(function Select(
  {
    className,
    style,
    uiSize = 'md',
    disabled,
    leftIcon,
    value,
    defaultValue,
    onChange,
    onValueChange,
    placeholder,
    name,
    required,
    children,
    ...triggerProps
  },
  ref
) {
  const ALL_VALUE = '__all__';

  type ParsedOption = { type: 'option'; value: string; label: React.ReactNode; disabled?: boolean };
  type ParsedGroup = { type: 'group'; label: React.ReactNode; options: ParsedOption[] };

  const parsedOptions = React.useMemo<Array<ParsedOption | ParsedGroup>>(() => {
    const out: Array<ParsedOption | ParsedGroup> = [];
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode; label?: React.ReactNode }>(child)) return;
      const type = child.type as string;
      if (type === 'option') {
        const rawValue = child.props.value ?? '';
        out.push({
          type: 'option',
          value: String(rawValue),
          label: child.props.children,
          disabled: !!child.props.disabled,
        });
        return;
      }
      if (type === 'optgroup') {
        const groupLabel = child.props.label ?? '';
        const groupOptions: ParsedOption[] = [];
        React.Children.forEach(child.props.children, (optChild) => {
          if (!React.isValidElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode }>(optChild)) return;
          if ((optChild.type as string) !== 'option') return;
          const rawValue = optChild.props.value ?? '';
          groupOptions.push({
            type: 'option',
            value: String(rawValue),
            label: optChild.props.children,
            disabled: !!optChild.props.disabled,
          });
        });
        out.push({ type: 'group', label: groupLabel, options: groupOptions });
      }
    });
    return out;
  }, [children]);

  const normalizedOptions = React.useMemo<Array<ParsedOption | ParsedGroup>>(() => {
    return parsedOptions.map((item) => {
      if (item.type === 'option') {
        return { ...item, value: item.value === '' ? ALL_VALUE : item.value };
      }
      return {
        ...item,
        options: item.options.map((opt) => ({
          ...opt,
          value: opt.value === '' ? ALL_VALUE : opt.value,
        })),
      };
    });
  }, [parsedOptions]);

  const rawValue = value ?? defaultValue ?? '';
  const normalizedValue = rawValue === '' ? ALL_VALUE : String(rawValue);

  const handleValueChange = (nextValue: string) => {
    const actualValue = nextValue === ALL_VALUE ? '' : nextValue;
    onValueChange?.(actualValue);
    if (onChange) {
      const event = { target: { value: actualValue, name } } as React.ChangeEvent<HTMLSelectElement>;
      onChange(event);
    }
  };

  return (
    <SelectPrimitive.Root
      value={value !== undefined ? normalizedValue : undefined}
      defaultValue={value === undefined && defaultValue !== undefined ? (defaultValue === '' ? ALL_VALUE : String(defaultValue)) : undefined}
      onValueChange={handleValueChange}
      disabled={disabled}
      name={name}
      required={required}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        className={selectTriggerClass({ uiSize, hasLeftIcon: !!leftIcon, disabled, className })}
        style={{ ...selectTriggerStyle, ...style }}
        {...triggerProps}
      >
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }}>
            {leftIcon}
          </div>
        )}
        <SelectPrimitive.Value placeholder={placeholder ?? '请选择...'} />
        <ChevronDown
          aria-hidden
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--text-muted)' }}
        />
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={selectContentClass}
          style={selectContentStyle}
          position="popper"
          sideOffset={8}
        >
          <SelectPrimitive.Viewport className={selectViewportClass} style={selectViewportStyle}>
            {normalizedOptions.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                无可用选项
              </div>
            ) : (
              normalizedOptions.map((item, idx) => {
                if (item.type === 'group') {
                  return (
                    <SelectPrimitive.Group key={`g-${idx}`}>
                      <SelectPrimitive.Label className={selectLabelClass} style={{ color: 'var(--text-muted)' }}>
                        {item.label}
                      </SelectPrimitive.Label>
                      {item.options.map((opt) => (
                        <SelectPrimitive.Item
                          key={`${opt.value}-${String(opt.label)}`}
                          value={opt.value}
                          disabled={opt.disabled}
                          className={selectItemClass}
                          style={{ color: 'var(--text-primary)' }}
                        >
                          <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                        </SelectPrimitive.Item>
                      ))}
                    </SelectPrimitive.Group>
                  );
                }
                return (
                  <SelectPrimitive.Item
                    key={`${item.value}-${String(item.label)}`}
                    value={item.value}
                    disabled={item.disabled}
                    className={selectItemClass}
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                );
              })
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
});

Select.displayName = 'Select';

