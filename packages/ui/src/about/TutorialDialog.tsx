import { useEffect, useRef } from 'react';

/**
 * The quick tutorial: how to move round the model, and why right-click matters.
 *
 * Opened from the About popup. Short on purpose — the two things a newcomer cannot
 * guess are that the camera lives on the keyboard and that right-click is where the
 * actions are; everything else the sidebar and the keys list (F1) already show.
 */
export function TutorialDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the dialog so Escape reaches it without the viewer's key handling seeing the
  // event first — every other key in this app belongs to the camera.
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about tutorial"
        role="dialog"
        aria-modal="true"
        aria-label="Quick tutorial"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
      >
        <div className="tutorial-title">Quick tutorial</div>

        <section className="tutorial-section">
          <div className="tutorial-heading">Moving the camera</div>
          <dl className="tutorial-keys">
            <dt><kbd>I</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd></dt>
            <dd>Pan the view up, left, down and right.</dd>
            <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows</dt>
            <dd>Orbit round the model. Hold <kbd>Shift</kbd> to turn in 15° steps.</dd>
            <dt>Scroll wheel or <kbd>+</kbd><kbd>−</kbd></dt>
            <dd>Zoom in and out.</dd>
            <dt><kbd>F</kbd></dt>
            <dd>Fit the whole model in view.</dd>
            <dt><kbd>1</kbd>–<kbd>7</kbd></dt>
            <dd>Jump to front, back, left, right, top, bottom or the angled view.</dd>
          </dl>
        </section>

        <section className="tutorial-section">
          <div className="tutorial-heading">Right-click is the main tool</div>
          <p className="about-line">
            Right-click anything — a face, an edge, a body, empty space or your sketch
            selection — and a ring of exactly the actions that apply to it opens around
            the cursor, each always in the same direction, so most of the work is a
            right-click and a flick.
          </p>
        </section>

        <p className="about-line about-dim">
          <kbd>F1</kbd> lists every key; <kbd>Ctrl</kbd>+<kbd>K</kbd> finds any command by name.
        </p>

        <button type="button" className="about-close" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}
