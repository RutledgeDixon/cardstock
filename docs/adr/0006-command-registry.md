# ADR-0006 — One registry behind the toolbar, radial menu, keys and palette

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 5

## Context

The brief is specific: the toolbar is one level deep with no submenus, ever; right-click
is the primary verb; and the same operations must be reachable by key and by search.
Four surfaces onto one set of actions is four chances for them to drift apart.

## Decision

Every user-invocable action is a `Command` in one registry. The toolbar, the radial menu,
the keybindings and the palette are all **views over that registry**.

This is what makes "no submenus" structural rather than aspirational: a command declares
which contexts it belongs to and, optionally, one toolbar slot and one radial sector.
There is nowhere for a submenu to live. Feature *variants* — a boolean's union/cut/
intersect, an extrude's blind/through-all — are fields in the feature's parameter panel,
which is the honest place for them rather than nesting they would otherwise force.

## Consequences worth stating

**Sectors are declared, not derived.** A command's radial direction is fixed per context,
not computed from whatever happens to be in the filtered list. That is the entire value of
a pie menu: learn the flick once and it never moves. Two commands claiming one sector in
one context throws at **registration**, not at render — a clash makes the layout
non-deterministic, which destroys exactly the muscle memory the fixed layout exists to
build, and a runtime clash would be invisible until a user noticed a menu had reshuffled.

**Overflow is flat.** Beyond eight commands the last sector becomes "More…", opening a
searchable list. It reserves its slot before filling, so it cannot displace a command that
would otherwise have had a home.

**Enablement carries its reason.** `enabled()` returns `true | string`, and disabled
buttons stay visible showing why in their tooltip. A button that vanishes teaches nothing;
a greyed one with no explanation is a dead end.

That signature also caught a real bug: booleans were gated on `featureCount >= 2`, but a
box with a fillet on it is two features and **one body**, so Cut looked available and
would have failed the moment it was pressed. `CommandState` now carries `bodyCount` —
features whose output nothing else consumes.

**Commands cannot touch the viewer or the kernel.** `@cardstock/commands` may import only
types and the document, so commands act through a `CommandHost` the app implements. They
describe intent; the app decides how intent is carried out. The whole command set is
therefore testable against a stub.

**One key has one owner.** Phase 1's keyboard adapter bound F, `.`, Tab and Escape
directly. Those are now Commands, and the adapter owns only navigation — orbit, pan, zoom,
named views. Two systems binding one key means whichever runs first wins by accident.

## Dimension editing

Typed inputs, never sliders — the user's requirement is precision, and a slider cannot
express 12.7 without a fight. Fields accept expressions as well as literals (`wall * 3`),
since parameters already support them, and show the evaluated result beneath while the
text differs from it so an expression is never opaque. Invalid input is reported inline
and **not committed**, so a typo cannot silently reshape the part.

## Honest placeholders

The Sketch button exists on the toolbar and is disabled, saying "Sketching arrives in
Phase 6". The toolbar is meant to be the real toolbar; a button that lies about what it
does is worse than one that says what it is waiting for.
