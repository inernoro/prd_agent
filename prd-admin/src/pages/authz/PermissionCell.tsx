interface PermissionCellProps {
  status: 'full' | 'partial' | 'none';
  isBuiltIn?: boolean;
  isHighlighted?: boolean;
  isEditing?: boolean;
  isRowHovered?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

// 自定义统一风格的圆圈图标
function StatusIcon({ status, color }: { status: 'full' | 'partial' | 'none'; color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {/* 外圈 */}
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" fill="none" />
      {/* 内圈 - 完全访问时填充，部分访问时半填充 */}
      {status === 'full' && <circle cx="8" cy="8" r="3.5" fill={color} />}
      {status === 'partial' && <circle cx="8" cy="8" r="2" fill={color} />}
      {/* 无权限时显示斜线 */}
      {status === 'none' && (
        <line x1="4" y1="12" x2="12" y2="4" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function PermissionCell({
  status,
  isBuiltIn,
  isHighlighted,
  isEditing,
  isRowHovered,
  onClick,
  disabled,
}: PermissionCellProps) {
  // 根据状态返回对应颜色
  const getStatusDisplay = () => {
    switch (status) {
      case 'full':
        return {
          color: isHighlighted ? 'rgba(214, 178, 106, 0.95)' : 'rgba(214, 178, 106, 0.8)',
          bg: 'rgba(214, 178, 106, 0.12)',
          label: '完全访问',
        };
      case 'partial':
        return {
          color: isHighlighted ? 'rgba(214, 178, 106, 0.8)' : 'rgba(214, 178, 106, 0.55)',
          bg: 'rgba(214, 178, 106, 0.06)',
          label: '部分访问',
        };
      case 'none':
      default:
        return {
          color: 'rgba(255, 255, 255, 0.25)',
          bg: 'transparent',
          label: '无权限',
        };
    }
  };

  const { color, bg, label } = getStatusDisplay();
  const canInteract = !disabled && !isBuiltIn;

  // 计算动态样式
  const getButtonStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled && !isBuiltIn ? 0.5 : 1,
    };

    if (isEditing) {
      return {
        ...baseStyle,
        background: 'rgba(214, 178, 106, 0.32)',
        border: '1.5px solid rgba(214, 178, 106, 0.65)',
        boxShadow: '0 8px 32px rgba(214, 178, 106, 0.4), 0 0 0 4px rgba(214, 178, 106, 0.1)',
        transform: 'scale(1.35)',
      };
    }

    if (isRowHovered && canInteract) {
      return {
        ...baseStyle,
        background: 'rgba(214, 178, 106, 0.1)',
        border: '1px solid rgba(214, 178, 106, 0.3)',
        boxShadow: '0 4px 16px rgba(214, 178, 106, 0.15)',
        transform: 'scale(1.18)',
      };
    }

    return {
      ...baseStyle,
      background: bg || 'transparent',
      border: '1px solid rgba(255, 255, 255, 0.04)',
      boxShadow: 'none',
      transform: 'scale(1)',
    };
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${label}${isBuiltIn ? ' (内置角色不可编辑)' : ''}`}
      className={`
        w-[34px] h-[34px] rounded-[10px] flex items-center justify-center mx-auto
        transition-all duration-250 ease-out
        ${canInteract ? 'hover:!scale-[1.45] hover:!bg-[rgba(214,178,106,0.28)] hover:!border-[rgba(214,178,106,0.55)] hover:!shadow-[0_6px_24px_rgba(214,178,106,0.4)] active:!scale-[1.25]' : ''}
      `}
      style={getButtonStyle()}
    >
      <StatusIcon status={status} color={color} />
    </button>
  );
}
