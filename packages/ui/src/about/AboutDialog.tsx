import { useEffect, useRef } from 'react';

/**
 * What the name means, and which build this is.
 *
 * The build identity is the working part: most testing happens between releases, so a
 * version number alone cannot answer "is this the fix?". The commit, and whether the
 * tree was dirty when it was built, can.
 */
export interface AboutInfo {
  readonly version: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly date: string;
  readonly occt: string;
  readonly planegcs: string;
  readonly three: string;
}

export function AboutDialog({
  info, author, onClose,
}: {
  info: AboutInfo;
  author: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the dialog so Escape reaches it without the viewer's key handling seeing the
  // event first — every other key in this app belongs to the camera.
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about"
        role="dialog"
        aria-modal="true"
        aria-label="About CARDstock"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
      >
        <div className="about-mark">
          <span className="about-card">CARD</span><span className="about-stock">stock</span>
        </div>

        <p className="about-expansion">
          <b>C</b>omputer <b>A</b>ssisted <b>R</b>apid <b>D</b>esign
          <span className="about-dim"> — stock, as in bare, no-frills.</span>
        </p>

        <p className="about-line">
          Parametric solid modelling, simplified. No bells or whistles or $$. Intended
          mainly for 3D printing.
        </p>

        <dl className="about-facts">
          <dt>Version</dt>
          <dd>
            {info.version}
            <span className="about-dim">
              {' · '}{info.commit}{info.dirty ? '+' : ''}{' · '}{info.date}
            </span>
          </dd>

          <dt>Author</dt>
          <dd>{author}</dd>

          <dt>Licence</dt>
          <dd>All rights reserved</dd>

          <dt>Kernel</dt>
          <dd>OpenCascade <span className="about-dim">{info.occt}</span></dd>

          <dt>Solver</dt>
          <dd>PlaneGCS <span className="about-dim">{info.planegcs}</span></dd>

          <dt>Renderer</dt>
          <dd>three.js <span className="about-dim">{info.three}</span></dd>
        </dl>

        <p className="about-line about-dim">
          {info.dirty
            ? 'Built from a working tree with uncommitted changes.'
            : 'Built from a clean working tree.'}
        </p>

        <button type="button" className="about-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
