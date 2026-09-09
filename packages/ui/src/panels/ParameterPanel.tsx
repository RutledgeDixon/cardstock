import type { FeatureId } from '@cardstock/types';
import { ExpressionInput } from '../inputs/ExpressionInput.js';

/**
 * The docked parameter panel.
 *
 * Modeless: it edits whatever is focused without blocking the viewport, so you can orbit
 * while typing a dimension. Every field is a typed input accepting expressions — feature
 * VARIANTS live here too (a boolean's op is a field), which is what keeps the toolbar
 * one level deep without hiding anything.
 */
export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  /**
   * When present the field is a pick-one list rather than a typed expression.
   *
   * A fastener size is not a quantity you can compute, and typing "M3" into a box that
   * wants a number is a mistake the UI shouldn't allow in the first place.
   */
  readonly choices?: readonly string[];
}

export function ParameterPanel({
  title, subtitle, fields, parameters, evaluate, onCommit, onCommitParameter, onPreview, footer,
}: {
  title: string;
  subtitle?: string;
  fields: readonly FieldSpec[];
  parameters: readonly FieldSpec[];
  evaluate: (expression: string) => { ok: true; value: number } | { ok: false; error: string };
  onCommit: (key: string, expression: string) => void;
  onCommitParameter: (name: string, expression: string) => void;
  onPreview?: (key: string, expression: string) => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="panel-dock" aria-label="Parameters">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        {subtitle && <span className="panel-sub">{subtitle}</span>}
      </div>

      {fields.length > 0 && (
        <section>
          {fields.map((field) => (field.choices ? (
            <div className="field" key={field.key}>
              <label htmlFor={`f-${field.key}`}>{field.label}</label>
              <div className="field-body">
                <select
                  id={`f-${field.key}`}
                  value={field.value}
                  onChange={(e) => onCommit(field.key, e.currentTarget.value)}
                >
                  {field.choices.map((choice) => (
                    <option key={choice} value={choice}>{choice}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <ExpressionInput
              key={field.key}
              label={field.label}
              value={field.value}
              unit={field.unit ?? 'mm'}
              evaluate={evaluate}
              onCommit={(expression) => onCommit(field.key, expression)}
              {...(onPreview ? { onPreview: (e: string) => onPreview(field.key, e) } : {})}
            />
          )))}
        </section>
      )}

      {parameters.length > 0 && (
        <section className="panel-params">
          <div className="panel-section-title">Parameters</div>
          {parameters.map((parameter) => (
            <ExpressionInput
              key={parameter.key}
              label={parameter.label}
              value={parameter.value}
              unit={parameter.unit ?? 'mm'}
              evaluate={evaluate}
              onCommit={(expression) => onCommitParameter(parameter.key, expression)}
            />
          ))}
        </section>
      )}

      {footer && <div className="panel-foot">{footer}</div>}
    </div>
  );
}

export type { FeatureId };
