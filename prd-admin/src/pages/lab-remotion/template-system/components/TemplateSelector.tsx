/**
 * 模板选择器组件
 * 展示所有可用模板，支持按分类筛选
 */
import { useState, useMemo } from 'react';
import { TemplateDefinition, TemplateCategory } from '../types';
import { getAllTemplates, getTemplatesByCategory, categoryInfo } from '../registry';

interface TemplateSelectorProps {
  selectedTemplate: TemplateDefinition | null;
  onSelect: (template: TemplateDefinition) => void;
}

export function TemplateSelector({ selectedTemplate, onSelect }: TemplateSelectorProps) {
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');

  const templates = useMemo(() => {
    if (activeCategory === 'all') {
      return getAllTemplates();
    }
    return getTemplatesByCategory(activeCategory);
  }, [activeCategory]);

  const categories: Array<{ key: TemplateCategory | 'all'; label: string; icon: string }> = [
    { key: 'all', label: '全部', icon: '📋' },
    ...Object.entries(categoryInfo).map(([key, info]) => ({
      key: key as TemplateCategory,
      label: info.label,
      icon: info.icon,
    })),
  ];

  return (
    <div className="template-selector">
      {/* 分类标签 */}
      <div className="category-tabs">
        {categories.map((cat) => (
          <button
            key={cat.key}
            className={`category-tab ${activeCategory === cat.key ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.key)}
          >
            <span className="category-icon">{cat.icon}</span>
            <span className="category-label">{cat.label}</span>
          </button>
        ))}
      </div>

      {/* 模板网格 */}
      <div className="template-grid">
        {templates.length === 0 ? (
          <div className="no-templates">
            <span className="no-templates-icon">📭</span>
            <span>该分类暂无模板</span>
          </div>
        ) : (
          templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isSelected={selectedTemplate?.id === template.id}
              onClick={() => onSelect(template)}
            />
          ))
        )}
      </div>

      <style>{`
        .template-selector {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .category-tabs {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .category-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 20px;
          font-size: 13px;
          color: #94a3b8;
          cursor: pointer;
          transition: all 0.2s;
        }

        .category-tab:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #e2e8f0;
        }

        .category-tab.active {
          background: rgba(99, 102, 241, 0.2);
          border-color: rgba(99, 102, 241, 0.5);
          color: #818cf8;
        }

        .category-icon {
          font-size: 14px;
        }

        .template-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 16px;
        }

        .no-templates {
          grid-column: 1 / -1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 40px;
          color: #64748b;
          font-size: 14px;
        }

        .no-templates-icon {
          font-size: 32px;
        }

        .template-card {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .template-card:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.2);
          transform: translateY(-2px);
        }

        .template-card.selected {
          background: rgba(99, 102, 241, 0.15);
          border-color: rgba(99, 102, 241, 0.5);
        }

        .template-thumbnail {
          width: 100%;
          aspect-ratio: 16 / 9;
          background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          overflow: hidden;
        }

        .template-thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .template-info {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .template-name {
          font-size: 15px;
          font-weight: 600;
          color: #e2e8f0;
        }

        .template-description {
          font-size: 12px;
          color: #64748b;
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .template-meta {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: #475569;
        }

        .template-meta-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
      `}</style>
    </div>
  );
}

/**
 * 单个模板卡片
 */
function TemplateCard({
  template,
  isSelected,
  onClick,
}: {
  template: TemplateDefinition;
  isSelected: boolean;
  onClick: () => void;
}) {
  const categoryIcon = categoryInfo[template.category]?.icon || '📄';

  return (
    <div className={`template-card ${isSelected ? 'selected' : ''}`} onClick={onClick}>
      <div className="template-thumbnail">
        {template.thumbnail ? (
          <img src={template.thumbnail} alt={template.name} />
        ) : (
          <span>{categoryIcon}</span>
        )}
      </div>
      <div className="template-info">
        <div className="template-name">{template.name}</div>
        <div className="template-description">{template.description}</div>
        <div className="template-meta">
          <span className="template-meta-item">⏱ {template.defaultDuration}秒</span>
          <span className="template-meta-item">
            📐 {template.supportedAspectRatios.join(', ')}
          </span>
        </div>
      </div>
    </div>
  );
}

export default TemplateSelector;
