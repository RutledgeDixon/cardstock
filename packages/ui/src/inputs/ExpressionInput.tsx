import { useEffect, useRef, useState } from 'react';

/**
 * A dimension field.
 *
 * Typed input, never a slider: the user's requirement is precision, and a slider cannot
 * express 12.7 without a fight. It accepts expressions as well as numbers — `wall * 3`,
 * `boltM3 + 0.4` — because the document's parameters already support them, and a
 * dimension that can only be a literal wastes that.
 *
 * The evaluated result is shown beneath while the text differs from it, so an expression
 * is never opaque. Invalid input is reported inline and NOT committed, so a typo cannot
 * silently reshape the part.
 */
export interface ExpressionInputProps {
  label: string;
  value: string;
  unit?: string;
  /** Evaluate for the preview and to validate. Return a message to reject. */
  evaluate: (expression: string) => { ok: true; value: number } | { ok: false; error: string };
  onCommit: (expression: string) => void;
  /** Fired on every valid keystroke, for live preview. */
  onPreview?: (expression: string) => void;
  autoFocus?: boolean;
}

export function ExpressionInput({
  label, value, unit = 'mm', evaluate, onCommit, onPreview, autoFocus,
}: ExpressionInputProps) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow the document when it changes underneath us — undo, a parameter edit
  // elsewhere — but never while the field is being typed in.
  useEffect(() => { if (!focused) setText(value); }, [value, focused]);

  const result = evaluate(text);
  const dirty = text !== value;

  const commit = () => {
    if (!result.ok) { setText(value); return; } // reject rather than reshape the part
    if (dirty) onCommit(text);
  };

  return (
    <div className={`field${result.ok ? '' : ' field-invalid'}`}>
      <label htmlFor={`f-${label}`}>{label}</label>
      <div className="field-body">
        <input
          id={`f-${label}`}
          ref={inputRef}
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const next = evaluate(e.target.value);
            if (next.ok) onPreview?.(e.target.value);
          }}
          onFocus={(e) => { setFocused(true); e.target.select(); }}
          onBlur={() => { setFocused(false); commit(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); inputRef.current?.blur(); }
            if (e.key === 'Escape') { setText(value); inputRef.current?.blur(); }
            // Arrow keys nudge the value, but must not reach the viewer's camera.
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && result.ok) {
              e.preventDefault();
              const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
              const next = result.value + (e.key === 'ArrowUp' ? step : -step);
              const rounded = String(Number(next.toFixed(4)));
              setText(rounded);
              onPreview?.(rounded);
            }
            e.stopPropagation();
          }}
        />
        <span className="field-unit">{unit}</span>
      </div>
      {!result.ok && <div className="field-error">{result.error}</div>}
      {result.ok && text.trim() !== String(result.value) && (
        <div className="field-preview">= {Number(result.value.toFixed(4))} {unit}</div>
      )}
    </div>
  );
}
