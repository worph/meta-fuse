import { useState, useEffect, useCallback } from 'react';
import type {
  RenamingConfig,
  RenamingRule,
  ConditionGroup,
  Condition,
  PreviewItem,
  TemplateVariable,
} from '../types/rules';
import { isConditionGroup, generateId } from '../types/rules';

interface RulesEditorProps {
  onSave?: () => void;
}

// Available metadata fields for conditions
const AVAILABLE_FIELDS = [
  { value: 'fileType', label: 'File Type', type: 'string' },
  { value: 'titles.eng', label: 'English Title', type: 'string' },
  { value: 'originalTitle', label: 'Original Title', type: 'string' },
  { value: 'season', label: 'Season', type: 'number' },
  { value: 'episode', label: 'Episode', type: 'number' },
  { value: 'extra', label: 'Is Extra', type: 'boolean' },
  { value: 'movieYear', label: 'Movie Year', type: 'number' },
  { value: 'year', label: 'Year', type: 'number' },
  { value: 'extension', label: 'Extension', type: 'string' },
  { value: 'version', label: 'Version', type: 'string' },
  { value: 'subtitleLanguage', label: 'Subtitle Language', type: 'string' },
];

const CONDITION_TYPES = [
  { value: 'EXISTS', label: 'exists', needsValue: false },
  { value: 'NOT_EXISTS', label: 'does not exist', needsValue: false },
  { value: 'EQUALS', label: 'equals', needsValue: true },
  { value: 'NOT_EQUALS', label: 'does not equal', needsValue: true },
  { value: 'CONTAINS', label: 'contains', needsValue: true },
  { value: 'MATCHES', label: 'matches regex', needsValue: true },
];

function createEmptyRule(): RenamingRule {
  return {
    id: generateId(),
    name: 'New Rule',
    description: '',
    enabled: true,
    priority: 50,
    conditions: { operator: 'AND', conditions: [] },
    template: '',
    fallbackToUnsorted: true,
  };
}

function createEmptyCondition(): Condition {
  return {
    type: 'EXISTS',
    field: 'titles.eng',
  };
}

// ConditionRow component
interface ConditionRowProps {
  condition: Condition;
  onChange: (condition: Condition) => void;
  onDelete: () => void;
}

function ConditionRow({ condition, onChange, onDelete }: ConditionRowProps) {
  const conditionType = CONDITION_TYPES.find(t => t.value === condition.type);
  const needsValue = conditionType?.needsValue ?? false;

  return (
    <div className="condition-row">
      <select
        value={condition.field}
        onChange={e => onChange({ ...condition, field: e.target.value })}
        className="condition-field"
      >
        {AVAILABLE_FIELDS.map(f => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      <select
        value={condition.type}
        onChange={e => onChange({ ...condition, type: e.target.value as Condition['type'] })}
        className="condition-type"
      >
        {CONDITION_TYPES.map(t => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      {needsValue && (
        <input
          type="text"
          value={String(condition.value ?? '')}
          onChange={e => onChange({ ...condition, value: e.target.value })}
          placeholder="Value"
          className="condition-value"
        />
      )}

      <button onClick={onDelete} className="btn-icon btn-delete" title="Remove condition">
        x
      </button>
    </div>
  );
}

// ConditionBuilder component
interface ConditionBuilderProps {
  conditions: ConditionGroup;
  onChange: (conditions: ConditionGroup) => void;
}

function ConditionBuilder({ conditions, onChange }: ConditionBuilderProps) {
  const addCondition = () => {
    onChange({
      ...conditions,
      conditions: [...conditions.conditions, createEmptyCondition()],
    });
  };

  const updateCondition = (index: number, updated: Condition | ConditionGroup) => {
    const newConditions = [...conditions.conditions];
    newConditions[index] = updated;
    onChange({ ...conditions, conditions: newConditions });
  };

  const deleteCondition = (index: number) => {
    const newConditions = conditions.conditions.filter((_, i) => i !== index);
    onChange({ ...conditions, conditions: newConditions });
  };

  return (
    <div className="condition-builder">
      <div className="condition-operator">
        <label>Match</label>
        <select
          value={conditions.operator}
          onChange={e => onChange({ ...conditions, operator: e.target.value as 'AND' | 'OR' })}
        >
          <option value="AND">ALL conditions (AND)</option>
          <option value="OR">ANY condition (OR)</option>
        </select>
      </div>

      <div className="condition-list">
        {conditions.conditions.length === 0 && (
          <div className="condition-empty">No conditions - rule will match all files</div>
        )}
        {conditions.conditions.map((cond, index) => (
          !isConditionGroup(cond) && (
            <ConditionRow
              key={index}
              condition={cond}
              onChange={updated => updateCondition(index, updated)}
              onDelete={() => deleteCondition(index)}
            />
          )
        ))}
      </div>

      <button onClick={addCondition} className="btn-add-condition">
        + Add Condition
      </button>
    </div>
  );
}

// TemplateEditor component
interface TemplateEditorProps {
  template: string;
  onChange: (template: string) => void;
  variables: TemplateVariable[];
}

function TemplateEditor({ template, onChange, variables }: TemplateEditorProps) {
  const [showVars, setShowVars] = useState(false);

  const insertVariable = (path: string) => {
    onChange(template + `{${path}}`);
  };

  return (
    <div className="template-editor">
      <div className="template-header">
        <label>Path Template</label>
        <button
          onClick={() => setShowVars(!showVars)}
          className="btn-small"
        >
          {showVars ? 'Hide Variables' : 'Show Variables'}
        </button>
      </div>

      <textarea
        value={template}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g., Movies/{titles.eng|originalTitle}{movieYear? ({movieYear})}/{fileName}.{extension}"
        rows={3}
        className="template-input"
      />

      {showVars && (
        <div className="variable-palette">
          {variables.map(v => (
            <button
              key={v.path}
              onClick={() => insertVariable(v.path)}
              className="variable-chip"
              title={`${v.description} (${v.type})`}
            >
              {v.name}
            </button>
          ))}
        </div>
      )}

      <div className="template-help">
        <span><code>{'{var}'}</code> basic</span>
        <span><code>{'{var:pad2}'}</code> zero-pad</span>
        <span><code>{'{var?}'}</code> optional</span>
        <span><code>{'{var?(text)}'}</code> conditional</span>
        <span><code>{'{var|default}'}</code> default</span>
      </div>
    </div>
  );
}

// RuleCard component
interface RuleCardProps {
  rule: RenamingRule;
  variables: TemplateVariable[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (rule: RenamingRule) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}

function RuleCard({
  rule,
  variables,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: RuleCardProps) {
  const conditionCount = rule.conditions.conditions.length;

  return (
    <div className={`rule-card ${expanded ? 'expanded' : ''} ${!rule.enabled ? 'disabled' : ''}`}>
      <div className="rule-header" onClick={onToggle}>
        <div className="rule-header-left">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={e => {
              e.stopPropagation();
              onUpdate({ ...rule, enabled: e.target.checked });
            }}
            title="Enable/disable rule"
          />
          <span className="rule-name">{rule.name}</span>
          <span className="rule-meta">
            Priority: {rule.priority} | {conditionCount} condition{conditionCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="rule-header-right">
          <button
            onClick={e => { e.stopPropagation(); onMoveUp(); }}
            disabled={isFirst}
            className="btn-icon"
            title="Move up"
          >
            ^
          </button>
          <button
            onClick={e => { e.stopPropagation(); onMoveDown(); }}
            disabled={isLast}
            className="btn-icon"
            title="Move down"
          >
            v
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="btn-icon btn-delete"
            title="Delete rule"
          >
            x
          </button>
          <span className="expand-icon">{expanded ? '-' : '+'}</span>
        </div>
      </div>

      {expanded && (
        <div className="rule-body">
          <div className="rule-field">
            <label>Name</label>
            <input
              type="text"
              value={rule.name}
              onChange={e => onUpdate({ ...rule, name: e.target.value })}
            />
          </div>

          <div className="rule-field">
            <label>Priority (higher = evaluated first)</label>
            <input
              type="number"
              value={rule.priority}
              onChange={e => onUpdate({ ...rule, priority: parseInt(e.target.value, 10) || 0 })}
              min={0}
              max={1000}
            />
          </div>

          <div className="rule-field">
            <label>Conditions</label>
            <ConditionBuilder
              conditions={rule.conditions}
              onChange={conditions => onUpdate({ ...rule, conditions })}
            />
          </div>

          <div className="rule-field">
            <TemplateEditor
              template={rule.template}
              onChange={template => onUpdate({ ...rule, template })}
              variables={variables}
            />
          </div>

          <div className="rule-field rule-field-inline">
            <label>
              <input
                type="checkbox"
                checked={rule.fallbackToUnsorted}
                onChange={e => onUpdate({ ...rule, fallbackToUnsorted: e.target.checked })}
              />
              Fall back to Unsorted folder if template fails
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// PreviewPanel component
interface PreviewPanelProps {
  previews: PreviewItem[];
  loading: boolean;
  total: number;
  limited: boolean;
}

function PreviewPanel({ previews, loading, total, limited }: PreviewPanelProps) {
  if (loading) {
    return <div className="preview-loading">Loading preview...</div>;
  }

  return (
    <div className="preview-panel">
      <div className="preview-header">
        <h3>Preview</h3>
        <span className="preview-count">
          Showing {previews.length} of {total} files
          {limited && ' (limited)'}
        </span>
      </div>

      {previews.length === 0 ? (
        <div className="preview-empty">No files to preview</div>
      ) : (
        <div className="preview-table-wrapper">
          <table className="preview-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Current Path</th>
                <th>New Path</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {previews.map((p, i) => {
                const changed = p.newVirtualPath !== p.currentVirtualPath;
                return (
                  <tr key={i} className={p.error ? 'error' : changed ? 'changed' : ''}>
                    <td title={p.sourcePath}>{p.sourcePath.split('/').pop()}</td>
                    <td title={p.currentVirtualPath}>{truncatePath(p.currentVirtualPath)}</td>
                    <td className={changed ? 'highlight' : ''} title={p.newVirtualPath || ''}>
                      {p.error ? (
                        <span className="error-text">{p.error}</span>
                      ) : (
                        truncatePath(p.newVirtualPath || '')
                      )}
                    </td>
                    <td>{p.matchedRule || '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(-maxLen + 3);
}

// Main RulesEditor component
export function RulesEditor({ onSave }: RulesEditorProps) {
  const [config, setConfig] = useState<RenamingConfig | null>(null);
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [previews, setPreviews] = useState<PreviewItem[]>([]);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewLimited, setPreviewLimited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch rules and variables on mount
  useEffect(() => {
    Promise.all([
      fetch('/api/fuse/rules').then(r => r.json()),
      fetch('/api/fuse/rules/variables').then(r => r.json()),
    ])
      .then(([rulesData, varsData]) => {
        setConfig(rulesData.config);
        setVariables(varsData.variables);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Fetch preview when config changes
  const fetchPreview = useCallback(async () => {
    if (!config) return;

    setPreviewLoading(true);
    try {
      const res = await fetch('/api/fuse/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: config.rules, limit: 20 }),
      });
      const data = await res.json();
      setPreviews(data.previews || []);
      setPreviewTotal(data.total || 0);
      setPreviewLimited(data.limited || false);
    } catch (err) {
      console.error('Failed to fetch preview:', err);
    } finally {
      setPreviewLoading(false);
    }
  }, [config]);

  // Debounced preview fetch
  useEffect(() => {
    if (!dirty || !config) return;
    const timeout = setTimeout(fetchPreview, 500);
    return () => clearTimeout(timeout);
  }, [config, dirty, fetchPreview]);

  // Initial preview
  useEffect(() => {
    if (config && !dirty) {
      fetchPreview();
    }
  }, [config, dirty, fetchPreview]);

  const handleSave = async () => {
    if (!config) return;

    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/fuse/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.errors?.join(', ') || data.error || 'Failed to save');
      }

      setDirty(false);
      onSave?.();
      // Refetch preview after save
      await fetchPreview();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateRules = (rules: RenamingRule[]) => {
    if (!config) return;
    setConfig({ ...config, rules });
    setDirty(true);
  };

  const addRule = () => {
    if (!config) return;
    const newRule = createEmptyRule();
    updateRules([...config.rules, newRule]);
    setExpandedRule(newRule.id);
  };

  const updateRule = (id: string, updated: RenamingRule) => {
    if (!config) return;
    updateRules(config.rules.map(r => r.id === id ? updated : r));
  };

  const deleteRule = (id: string) => {
    if (!config) return;
    if (confirm('Are you sure you want to delete this rule?')) {
      updateRules(config.rules.filter(r => r.id !== id));
      if (expandedRule === id) setExpandedRule(null);
    }
  };

  const moveRule = (index: number, direction: -1 | 1) => {
    if (!config) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= config.rules.length) return;

    const rules = [...config.rules];
    [rules[index], rules[newIndex]] = [rules[newIndex], rules[index]];
    updateRules(rules);
  };

  if (loading) {
    return <div className="rules-loading">Loading rules configuration...</div>;
  }

  if (!config) {
    return <div className="rules-error">Failed to load rules configuration</div>;
  }

  return (
    <div className="rules-editor">
      <div className="rules-header">
        <h2>Renaming Rules</h2>
        <div className="rules-actions">
          {dirty && <span className="unsaved-badge">Unsaved changes</span>}
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`btn-save ${dirty ? 'btn-primary' : ''}`}
          >
            {saving ? 'Saving...' : 'Save & Apply'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rules-error-message">{error}</div>
      )}

      <div className="rules-content">
        <div className="rules-list">
          {config.rules.length === 0 && (
            <div className="rules-empty">
              No rules configured. Click "Add Rule" to create one.
            </div>
          )}
          {config.rules.map((rule, index) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              variables={variables}
              expanded={expandedRule === rule.id}
              onToggle={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
              onUpdate={updated => updateRule(rule.id, updated)}
              onDelete={() => deleteRule(rule.id)}
              onMoveUp={() => moveRule(index, -1)}
              onMoveDown={() => moveRule(index, 1)}
              isFirst={index === 0}
              isLast={index === config.rules.length - 1}
            />
          ))}

          <button onClick={addRule} className="btn-add-rule">
            + Add Rule
          </button>
        </div>

        <PreviewPanel
          previews={previews}
          loading={previewLoading}
          total={previewTotal}
          limited={previewLimited}
        />
      </div>
    </div>
  );
}

export default RulesEditor;
