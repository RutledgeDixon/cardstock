import { useEffect, useRef } from 'react';

/**
 * Every key, in one place.
 *
 * The camera keys are a fixed table — they belong to the viewer, not the registry —
 * and every other chord is read from the commands themselves, so this can never drift
 * from what the keys actually do. Keyboard navigation is the unfamiliar part of the
 * app; the first thing a new user needs is this page, and it opens on `?`.
 */
export interface KeyBinding {
  readonly keys: readonly string[];
  readonly title: string;
  readonly hint?: string;
}

export const CAMERA_KEYS: readonly KeyBinding[] = [
  { keys: ['← →', 'A D'], title: 'Orbit around', hint: 'hold to keep turning; eases in and out' },
  { keys: ['↑ ↓', 'W S'], title: 'Orbit up and down', hint: 'clamped, so the model never rolls' },
  { keys: ['Shift + arrows'], title: 'Snap-orbit 15°' },
  { keys: ['Ctrl + arrows'], title: 'Pan' },
  { keys: ['+', '−'], title: 'Zoom in and out', hint: 'scroll wheel works too' },
  { keys: ['1 … 6'], title: 'Front · back · left · right · top · bottom' },
  { keys: ['7', '0'], title: 'Isometric' },
];

const pretty = (chord: string) => chord
  .split('+')
  .map((p) => ({
    ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta', escape: 'Esc', delete: 'Del',
    backspace: '⌫', tab: 'Tab', enter: '↵', ' ': 'Space',
  })[p] ?? (p.length === 1 ? p.toUpperCase() : p))
  .join(' + ');

export function KeysDialog({ commands, onClose }: {
  /** Commands that carry a key, in the order to show them. */
  commands: readonly KeyBinding[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const table = (rows: readonly KeyBinding[], format: (k: string) => string) => (
    <table className="keys-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.title}>
            <td className="keys-chords">
              {row.keys.map((k) => <kbd key={k}>{format(k)}</kbd>)}
            </td>
            <td>
              {row.title}
              {row.hint && <span className="about-dim"> — {row.hint}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about keys"
        role="dialog"
        aria-modal="true"
        aria-label="Keys"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === '?') onClose(); }}
      >
        <div className="panel-head">
          <span className="panel-title">Keys</span>
          <span className="panel-sub">the camera is on the keyboard; the mouse selects</span>
        </div>
        <div className="keys-columns">
          <div>
            <div className="panel-section-title">Camera</div>
            {table(CAMERA_KEYS, (k) => k)}
          </div>
          <div>
            <div className="panel-section-title">Commands</div>
            {table(commands, pretty)}
          </div>
        </div>
        <div className="export-actions">
          <button type="button" className="about-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
