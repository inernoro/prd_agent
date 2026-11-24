import { Hash, UserRound } from 'lucide-react';
import { getCategoryFilterOptions } from '@/lib/marketplaceTypes';

interface Props {
  category: string;
  onCategoryChange: (category: string) => void;
  categoryTourAnchor?: boolean;
  roles: Array<[string, string]>;
  role: string;
  onRoleChange: (role: string) => void;
  tags: Array<{ tag: string; count: number }>;
  tag: string;
  onTagChange: (tag: string) => void;
}

/** 桌面左栏与手机筛选弹层共用，分类与角色仍由原有注册表/接口提供。 */
export function MarketplaceFilters({ category, onCategoryChange, categoryTourAnchor = true, roles, role, onRoleChange, tags, tag, onTagChange }: Props) {
  return (
    <div className="marketplace-filters" aria-label="市场筛选">
      <fieldset data-tour-id={categoryTourAnchor ? 'marketplace-category-tabs' : undefined}>
        <legend>内容类型</legend>
        {getCategoryFilterOptions().filter(option => option.key !== 'all').map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" aria-pressed={category === key} data-active={category === key}
            className="marketplace-filter-row" onClick={() => onCategoryChange(key)}>
            {Icon && <Icon size={15} />}<span>{label}</span>
          </button>
        ))}
      </fieldset>
      {category === 'skill' && roles.length > 0 && (
        <fieldset data-tour-id="marketplace-role-row">
          <legend>适用角色</legend>
          <button type="button" aria-pressed={!role} data-active={!role} className="marketplace-filter-row" onClick={() => onRoleChange('')}>
            <UserRound size={15} /><span>不限</span>
          </button>
          {roles.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={role === key} data-active={role === key}
              className="marketplace-filter-row" onClick={() => onRoleChange(role === key ? '' : key)}>
              <UserRound size={15} /><span>{label}</span>
            </button>
          ))}
        </fieldset>
      )}
      {category === 'skill' && tags.length > 0 && (
        <fieldset data-tour-id="marketplace-tag-filters">
          <legend>技能标签</legend>
          <button type="button" aria-pressed={!tag} data-active={!tag} className="marketplace-filter-row" onClick={() => onTagChange('')}>
            <Hash size={15} /><span>不限</span>
          </button>
          {tags.map(({ tag: value, count }) => (
            <button key={value} type="button" aria-pressed={tag === value} data-active={tag === value}
              className="marketplace-filter-row" onClick={() => onTagChange(tag === value ? '' : value)}>
              <Hash size={15} /><span>{value}</span><span className="marketplace-filter-count">{count}</span>
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
