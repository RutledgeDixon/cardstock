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

## Amendment — a command belongs in exactly one place (review pass)

Three of the boolean children and `modify.move` declared radial sectors, and the
primitives declared toolbar slots, while all of them were group children. A child never
appears at a context menu's top level, so those declarations were unreachable — and the
sectors were worse than unreachable, because a sector is *reserved* at registration.
`modify.body` could not take the face menu's slot because its own child `modify.move` was
holding it, and the registry correctly refused the clash.

The registry now rejects a child that declares a sector or a toolbar slot, for the same
reason it rejects a sector clash: the alternative is a declaration that silently does
nothing until it blocks something real.

## Where an operation lands

The host resolved every new feature against `terminalFeature()` — the last leaf in the
tree. With one body that is right and invisible. With two it is wrong in a way that looks
like the app being "tied to the first thing you drew": pick a face on the second body,
press Shell, and the first body is hollowed instead. Worse for edge operations, where the
picked indices only mean anything against the shape they came from, so the fillet would
land on a real but unrelated edge.

A body id **is** the id of the feature that produced it, so the selection names the target
outright. The rule now: the selection wins; the terminal feature is the fallback when
nothing is selected; geometry selected across two bodies is refused rather than guessed.
Booleans take the same route — two selected bodies say which is base and which is tool,
which for a cut is the difference between the two possible answers.

Feature defaults are seated on the **target body's** bounding box rather than the whole
scene, because a hole centred between two bodies 60mm apart lands in the gap, cuts
nothing, and reports success.

## Amendment — WASD, and Delete meaning one thing (post-review)

**WASD is a second name for the arrow keys**, aliased once at the door of the keyboard
adapter rather than added to each set and branch. Shift-snapping, ctrl-panning and
held-key release all read it without knowing it exists, and W and ArrowUp spell one held
key — releasing either cancels the press, so mixing them cannot leave the camera orbiting
with nothing held down.

Two commands owned S and D and were rebound: Sketch to **N** (new sketch) and Dimension to
**M** (measure). A key that orbits the model everywhere except inside one command is worse
than a rebind.

**Delete is one command, not two.** It used to be `feature.delete` (the focused tree item)
and `sketch.delete` (sketch geometry), which is two answers to a question the user asks
once. Now: inside a sketch it removes the selected geometry; outside one, picking ANY part
of a body — a face, an edge, a vertex — removes that body, because nobody selects a single
face in order to delete a face. `CommandState` gained `sketchSelectionCount`, since a
sketch's selection is not the viewport's and Delete has to know which one it is about to
act on.


## Amendment — one level of submenu, allowed and bounded (post-review)

The user's original rule was "no submenus, ever". It has moved twice, and now settles at
**exactly one level, never deeper** — which is what the registry has enforced since the
first amendment, and what the constraint menu now uses.

Two things learned by putting constraints there:

**A group's tooltip is unreachable.** Hovering a group opens its flyout, so the tooltip
never appears — which meant a disabled group was greyed out with its reason written
somewhere no one could read it. Combine looked broken for exactly this reason: greyed,
silent, and nothing to indicate why. The reason is now rendered INSIDE the flyout, above
the items, and a disabled group still opens.

**A disabled entry should teach.** Every constraint carries the selection it wants —
"Perpendicular — Select two lines" — so a greyed row says what to do instead of dead-ending.
