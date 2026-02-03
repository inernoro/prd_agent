/**
 * 模板参数编辑表单
 * 根据模板的 fieldMeta 自动生成表单 UI
 */
import { useMemo, useCallback } from 'react';
import { z } from 'zod';
import { TemplateDefinition, FieldMeta } from '../types';

interface TemplateParamsFormProps {
  template: TemplateDefinition<z.ZodObject<any>>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}

interface FieldGroup {
  name: string;
  fields: Array<{ key: string; meta: FieldMeta }>;
}

export function TemplateParamsForm({
  template,
  values,
  onChange,
  disabled = false,
}: TemplateParamsFormProps) {
  // 按组分类字段
  const fieldGroups = useMemo(() => {
    const groups: Record<string, FieldGroup> = {};
    const noGroupFields: Array<{ key: string; meta: FieldMeta }> = [];

    for (const [key, meta] of Object.entries(template.fieldMeta)) {
      if (meta.group) {
        if (!groups[meta.group]) {
          groups[meta.group] = { name: meta.group, fields: [] };
        }
        groups[meta.group].fields.push({ key, meta });
      } else {
        noGroupFields.push({ key, meta });
      }
    }

    const result: FieldGroup[] = Object.values(groups);
    if (noGroupFields.length > 0) {
      result.unshift({ name: '基本设置', fields: noGroupFields });
    }

    return result;
  }, [template.fieldMeta]);

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...values, [key]: value });
    },
    [values, onChange]
  );

  return (
    <div className="template-params-form">
      {fieldGroups.map((group) => (
        <FieldGroupSection
          key={group.name}
          group={group}
          values={values}
          onChange={handleFieldChange}
          disabled={disabled}
        />
      ))}

      <style>{`
        .template-params-form {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .field-group {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          padding: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .field-group-title {
          font-size: 14px;
          font-weight: 600;
          color: #94a3b8;
          margin-bottom: 16px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .field-group-fields {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .form-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .form-field-label {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 500;
          color: #e2e8f0;
        }

        .form-field-description {
          font-size: 12px;
          color: #64748b;
        }

        .form-input {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 14px;
          color: #fff;
          transition: all 0.2s;
          width: 100%;
          box-sizing: border-box;
        }

        .form-input:focus {
          outline: none;
          border-color: #6366f1;
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
        }

        .form-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .form-input::placeholder {
          color: #475569;
        }

        .form-textarea {
          min-height: 80px;
          resize: vertical;
        }

        .form-color-input {
          padding: 4px;
          height: 42px;
          cursor: pointer;
        }

        .form-color-wrapper {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .form-color-preview {
          width: 42px;
          height: 42px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .form-color-text {
          flex: 1;
        }

        .array-field {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .array-item {
          background: rgba(0, 0, 0, 0.2);
          border-radius: 8px;
          padding: 16px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .array-item-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .array-item-title {
          font-size: 13px;
          font-weight: 500;
          color: #94a3b8;
        }

        .array-item-remove {
          background: rgba(239, 68, 68, 0.2);
          border: none;
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 12px;
          color: #f87171;
          cursor: pointer;
          transition: all 0.2s;
        }

        .array-item-remove:hover {
          background: rgba(239, 68, 68, 0.3);
        }

        .array-item-fields {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
        }

        .array-add-button {
          background: rgba(99, 102, 241, 0.2);
          border: 1px dashed rgba(99, 102, 241, 0.5);
          border-radius: 8px;
          padding: 12px;
          font-size: 13px;
          color: #818cf8;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .array-add-button:hover {
          background: rgba(99, 102, 241, 0.3);
          border-color: rgba(99, 102, 241, 0.7);
        }

        .form-checkbox-wrapper {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .form-checkbox {
          width: 20px;
          height: 20px;
          accent-color: #6366f1;
        }

        .form-select {
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          padding-right: 36px;
        }
      `}</style>
    </div>
  );
}

/**
 * 字段组区块
 */
function FieldGroupSection({
  group,
  values,
  onChange,
  disabled,
}: {
  group: FieldGroup;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  return (
    <div className="field-group">
      <div className="field-group-title">{group.name}</div>
      <div className="field-group-fields">
        {group.fields.map(({ key, meta }) => (
          <FormField
            key={key}
            meta={meta}
            value={values[key]}
            onChange={(value) => onChange(key, value)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 单个表单字段
 */
function FormField({
  meta,
  value,
  onChange,
  disabled,
}: {
  meta: FieldMeta;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const renderInput = () => {
    switch (meta.type) {
      case 'text':
        return (
          <input
            type="text"
            className="form-input"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={meta.placeholder}
            disabled={disabled}
          />
        );

      case 'textarea':
        return (
          <textarea
            className="form-input form-textarea"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={meta.placeholder}
            disabled={disabled}
          />
        );

      case 'number':
        return (
          <input
            type="number"
            className="form-input"
            value={(value as number) ?? ''}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            min={meta.min}
            max={meta.max}
            step={meta.step}
            placeholder={meta.placeholder}
            disabled={disabled}
          />
        );

      case 'color':
        return (
          <div className="form-color-wrapper">
            <div
              className="form-color-preview"
              style={{ backgroundColor: (value as string) || '#000000' }}
            />
            <input
              type="text"
              className="form-input form-color-text"
              value={(value as string) || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder="#6366f1"
              disabled={disabled}
            />
            <input
              type="color"
              className="form-input form-color-input"
              value={(value as string) || '#000000'}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              style={{ width: 50 }}
            />
          </div>
        );

      case 'image':
        return (
          <input
            type="url"
            className="form-input"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={meta.placeholder || 'https://example.com/image.png'}
            disabled={disabled}
          />
        );

      case 'boolean':
        return (
          <div className="form-checkbox-wrapper">
            <input
              type="checkbox"
              className="form-checkbox"
              checked={(value as boolean) || false}
              onChange={(e) => onChange(e.target.checked)}
              disabled={disabled}
            />
            <span style={{ color: '#94a3b8', fontSize: 13 }}>
              {(value as boolean) ? '已启用' : '未启用'}
            </span>
          </div>
        );

      case 'select':
        return (
          <select
            className="form-input form-select"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          >
            <option value="">请选择</option>
            {meta.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );

      case 'array':
        return (
          <ArrayField
            value={(value as Array<Record<string, unknown>>) || []}
            onChange={onChange}
            meta={meta}
            disabled={disabled}
          />
        );

      default:
        return (
          <input
            type="text"
            className="form-input"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={meta.placeholder}
            disabled={disabled}
          />
        );
    }
  };

  return (
    <div className="form-field">
      <label className="form-field-label">
        {meta.label}
        {meta.description && (
          <span className="form-field-description">({meta.description})</span>
        )}
      </label>
      {renderInput()}
    </div>
  );
}

/**
 * 数组字段（如演讲者列表）
 */
function ArrayField({
  value,
  onChange,
  meta,
  disabled,
}: {
  value: Array<Record<string, unknown>>;
  onChange: (value: unknown) => void;
  meta: FieldMeta;
  disabled: boolean;
}) {
  const handleAddItem = () => {
    const newItem: Record<string, unknown> = {};
    // 初始化新项的默认值
    if (meta.arrayItemFields) {
      for (const key of Object.keys(meta.arrayItemFields)) {
        newItem[key] = '';
      }
    }
    onChange([...value, newItem]);
  };

  const handleRemoveItem = (index: number) => {
    const newValue = [...value];
    newValue.splice(index, 1);
    onChange(newValue);
  };

  const handleItemFieldChange = (index: number, key: string, fieldValue: unknown) => {
    const newValue = [...value];
    newValue[index] = { ...newValue[index], [key]: fieldValue };
    onChange(newValue);
  };

  return (
    <div className="array-field">
      {value.map((item, index) => (
        <div key={index} className="array-item">
          <div className="array-item-header">
            <span className="array-item-title">#{index + 1}</span>
            <button
              type="button"
              className="array-item-remove"
              onClick={() => handleRemoveItem(index)}
              disabled={disabled}
            >
              删除
            </button>
          </div>
          <div className="array-item-fields">
            {meta.arrayItemFields &&
              Object.entries(meta.arrayItemFields).map(([key, fieldMeta]) => (
                <FormField
                  key={key}
                  meta={fieldMeta}
                  value={item[key]}
                  onChange={(v) => handleItemFieldChange(index, key, v)}
                  disabled={disabled}
                />
              ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="array-add-button"
        onClick={handleAddItem}
        disabled={disabled}
      >
        <span>+</span> 添加项目
      </button>
    </div>
  );
}

export default TemplateParamsForm;
