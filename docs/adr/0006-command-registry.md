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

## Amendment — one level of submenu, declared in the registry (Phase 7)

The original rule was "no submenus, ever". The user revised it: a create-shape button with
a flyout of shapes, then fillet/chamfer under "modify edge", and in Phase 7 the same shape
for the rest of the feature set. The rule that survives is not *no nesting* but **exactly
one level, and never a second**.

So a group is not a special kind of object. It is a command with `children: string[]` and
no `run` worth calling. The registry enforces the depth:

- A child may not itself be a group — checked at **registration**, like sector clashes.
- A child never appears on the toolbar in its own right; `registry.toolbar()` filters
  children out, so a command is in exactly one place.
- `forContext` filters them out too, which is why fillet and chamfer vanished from the
  edge menu's top level the moment they became children of "modify edge".

The tests assert the *shape* rather than a list of group names — every group holds only
leaves, and every command is reachable from a toolbar slot, a group, a context menu or a
key. Adding a submenu therefore needs no test edited; breaking the rule fails.

**One Submenu component.** The toolbar flyout and the radial menu's flyout were briefly
two implementations that drifted. They are now one `Submenu` in `@cardstock/ui`, portalled
to `document.body` (a flyout clipped by its own panel's `overflow` is the failure mode),
positioned from a `SubmenuAnchor` its caller measures **once** — re-measuring on pointer
entry moves the menu out from under the cursor, which then closes it. Appearance lives in
one `.submenu` CSS block, so changing how every flyout looks is one edit.

**Toolbar grouping in Phase 7.** Six new features would have made a strip of fifteen
buttons. They became four groups — Build (extrude, revolve), Modify (shell, mirror, move),
Pattern (linear, circular), Combine (cut, union, intersect) — plus Hole on its own, since
a hole is the single most-used operation for printed parts and deserves one click. Export
is `pin: 'end'`, sitting at the foot of the strip like a desktop panel's tray rather than
being the button that scrolls away as the modelling tools grow.

## Non-numeric fields

`standard: 'M3'` is not an expression, and evaluating it as one is an error report about
nothing. Feature definitions now declare `choiceKeys` alongside `valueKeys`; only the
latter are evaluated, and the former render as a pick-one list. The panel builds its
fields from what the definition *declares*, not from what the feature happens to hold, so
a pattern created with only a direction-x still offers direction-y and direction-z — a
field that doesn't exist can't be typed into.
