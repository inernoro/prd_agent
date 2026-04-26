import { useEffect, useState, useMemo } from 'react';
import { listAuthorizations, type AuthorizationSummary } from '@/services/real/authorizations';
import { ExternalLink, Key } from 'lucide-react';
import { Link } from 'react-router-dom';

interface Props {
  authType: string;
  value?: string;
  onChange: (id: string) => void;
  inputStyle?: React.CSSProperties;
}

const TYPE_ICONS: Record<string, string> = {
  tapd: '🐛',
  yuque: '📝',
  github: '🐙',
};

/**
 * 授权选择器组件。
 * 从外部授权中心拉取用户已授权的账号，以下拉框展示。
 * 列表为空时引导用户跳转添加。
 */
export function AuthPicker({ authType, value, onChange, inputStyle }: Props) {
  const [items, setItems] = useState<AuthorizationSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    listAuthorizations()
      .then(res => {
        if (res.success) {
          const list = (res.data || []).filter(a => a.type === authType && a.status === 'active');
          setItems(list);
        }
      })
      .finally(() => setLoading(false));
  }, [authType]);

  const typeIcon = TYPE_ICONS[authType] || '🔌';

  const options = useMemo(() => items.map(it => ({
    value: it.id,
    label: `${typeIcon} ${it.name}`,
  })), [items, typeIcon]);

  if (loading) {
    return (
      <div className="w-full h-9 px-3 flex items-center text-[13px] rounded-[8px]" style={inputStyle}>
        加载中…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="w-full p-3 rounded-[8px] text-[12px] flex items-start gap-2 border"
        style={{
          ...inputStyle,
          background: 'rgba(59,130,246,0.08)',
          borderColor: 'rgba(59,130,246,0.3)',
          color: 'var(--text-secondary)',
        }}
      >
        <Key size={14} className="flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div>还没有 {authType.toUpperCase()} 授权。请先到</div>
          <Link
            to="/admin/open-platform?tab=auth"
            target="_blank"
            className="inline-flex items-center gap-1 text-blue-400 hover:underline mt-1"
          >
            开放平台 → 外部授权 <ExternalLink size={10} />
          </Link>
          <span> 添加，再回来这里选择。</span>
        </div>
      </div>
    );
  }

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-9 px-3 rounded-[8px] text-[13px]"
      style={inputStyle}
    >
      <option value="">请选择已授权的 {authType.toUpperCase()} 账号</option>
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
