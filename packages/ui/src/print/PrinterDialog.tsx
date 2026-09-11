import { useEffect, useRef, useState } from 'react';

/**
 * The printer the part is going to. Typed numbers, saved on OK.
 *
 * Knows nothing about what the numbers drive; the host applies them to the expression
 * environment, the shading and the build-volume box.
 */
export interface PrinterFields {
  readonly name: string;
  readonly bed: { readonly x: number; readonly y: number; readonly z: number };
  readonly nozzle: number;
  readonly layer: number;
  readonly maxOverhang: number;
  readonly filamentDiameter: number;
  readonly density: number;
}

export function PrinterDialog({
  printer, onSave, onClose,
}: {
  printer: PrinterFields;
  onSave: (printer: PrinterFields) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const [draft, setDraft] = useState<PrinterFields>(printer);

  const number = (
    label: string, value: number, unit: string, step: number, set: (v: number) => void,
  ) => (
    <div className="field" key={label}>
      <label htmlFor={`printer-${label}`}>{label}</label>
      <div className="field-body">
        <input
          id={`printer-${label}`}
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) set(v);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="field-unit">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about export printer"
        role="dialog"
        aria-modal="true"
        aria-label="Printer"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') onSave(draft);
        }}
      >
        <div className="panel-head">
          <span className="panel-title">Printer</span>
          <span className="panel-sub">what the part is going to</span>
        </div>

        <div className="field">
          <label htmlFor="printer-name">Name</label>
          <div className="field-body">
            <input
              id="printer-name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>

        <div className="printer-grid printer-grid-3">
          {number('Bed X', draft.bed.x, 'mm', 10, (v) => setDraft({ ...draft, bed: { ...draft.bed, x: v } }))}
          {number('Bed Y', draft.bed.y, 'mm', 10, (v) => setDraft({ ...draft, bed: { ...draft.bed, y: v } }))}
          {number('Height', draft.bed.z, 'mm', 10, (v) => setDraft({ ...draft, bed: { ...draft.bed, z: v } }))}
        </div>
        <div className="printer-grid printer-grid-3">
          {number('Nozzle', draft.nozzle, 'mm', 0.1, (v) => setDraft({ ...draft, nozzle: v }))}
          {number('Layer', draft.layer, 'mm', 0.05, (v) => setDraft({ ...draft, layer: v }))}
          {number('Max overhang', draft.maxOverhang, '°', 5, (v) => setDraft({ ...draft, maxOverhang: Math.min(89, v) }))}
        </div>
        <div className="printer-grid printer-grid-2">
          {number('Filament', draft.filamentDiameter, 'mm', 0.1, (v) => setDraft({ ...draft, filamentDiameter: v }))}
          {number('Density', draft.density, 'g/cm³', 0.01, (v) => setDraft({ ...draft, density: v }))}
        </div>

        <p className="about-line about-dim">
          <code>nozzle</code> and <code>layer</code> are usable in any dimension — <code>wall = nozzle * 3</code>.
        </p>

        <div className="export-actions">
          <button type="button" className="about-close" onClick={onClose}>Cancel</button>
          <button type="button" className="about-close export-go" onClick={() => onSave(draft)}>OK</button>
        </div>
      </div>
    </div>
  );
}
