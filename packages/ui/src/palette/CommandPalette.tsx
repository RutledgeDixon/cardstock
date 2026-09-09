import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandRegistry, CommandState } from '@cardstock/commands';

/**
 * Ctrl+K. Every command, searchable, with its key binding shown — which doubles as the
 * shortcut reference, so there is no separate list to fall out of date.
 */
export function CommandPalette({
  registry, state, onRun, onClose,
}: {
  registry: CommandRegistry;
  state: CommandState;
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => registry.search(query, state), [registry, query, state]);
  const chords = useMemo(() => {
    const byCommand = new Map<string, string[]>();
    for (const [chord, command] of registry.keymap()) {
      byCommand.set(command.id, [...(byCommand.get(command.id) ?? []), chord]);
    }
    return byCommand;
  }, [registry]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setCursor(0); }, [query]);

  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search commands…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter') {
              const chosen = results[cursor];
              // Running a disabled command from the palette would be a silent no-op, so
              // it stays selectable but inert and keeps showing why.
              if (chosen && chosen.enabled === true) { onRun(chosen.command.id); onClose(); }
            }
          }}
        />
        <ul className="palette-list">
          {results.length === 0 && <li className="palette-empty">No matching command</li>}
          {results.map(({ command, enabled }, index) => (
            <li
              key={command.id}
              className={`palette-row${index === cursor ? ' is-cursor' : ''}${enabled === true ? '' : ' is-disabled'}`}
              onPointerEnter={() => setCursor(index)}
              onPointerDown={() => { if (enabled === true) { onRun(command.id); onClose(); } }}
            >
              <span className="palette-icon" aria-hidden="true">{command.icon}</span>
              <span className="palette-title">{command.title}</span>
              <span className="palette-hint">
                {enabled === true ? (command.hint ?? '') : String(enabled)}
              </span>
              <span className="palette-keys">
                {(chords.get(command.id) ?? []).map((chord) => (
                  <kbd key={chord}>{chord}</kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
