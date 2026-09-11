# ADR-0008 — Files, autosave, and the app's own storage

**Status:** Accepted · **Date:** 2026-09-10 · **Phase:** 10 (first layer)

## Context

Until now a refresh lost the model. `Document.toJSON()` existed and round-tripped in a
test — but the test bolted the sketches on by hand, because `toJSON()` never wrote them.
A `.card` file could not rebuild a sketched part from its own contents.

The goal is a downloadable app with its own filespace. This ADR covers the layers that are
the same whether that ends up a PWA or a desktop shell: the file format, the storage
behind autosave and recents, and the open/save surface.

## The file: schema version 2

Adds `sketches`, keyed by the id a feature's `sketchId` names. The 1→2 migration adds an
empty table, which is honest about what version-1 files contain. Validation refuses a
feature that names a sketch the file does not carry — otherwise every rebuild fails with
"this sketch feature has no sketch", which blames the feature for a hole in the file.

`meta` gains an optional **thumbnail** (a ~4 kB JPEG data URL, 240px wide) and **camera**
(azimuth, elevation, zoom, pivot). The thumbnail makes a recent-files list useful without
rebuilding anything; the camera makes reopening feel like you never left. Both are
validated and dropped when malformed: a bad thumbnail is a broken image, a bad camera is a
NaN projection and a viewport that silently stops picking (ADR-0002).

## Loading in place

`Document.load(file)` replaces the contents of the existing instance rather than
constructing a new one. The app, the host and the harness all hold one `Document`; a new
instance would leave every one of them pointing at the old model. Undo history is cleared
— there is nothing before the file — and the graph is marked fully dirty. Id counters are
re-derived from the file so a new sketch cannot collide with `sk7`.

## Change tracking

`Document.revision` is a counter bumped on every edit, and `subscribe()` fires after the
edit lands. A counter rather than a dirty flag because two things compare against a
moment — the last save and the last autosave — and a flag can only answer one of them.
`revision !== savedRevision` is what the title bar's `•` means.

## Storage

**IndexedDB**, wrapped as a key/value store, holds what must survive a reload but is not
a file the user chose: the autosave snapshot, the recent-files list, and the file handles
that let Save overwrite in place. Handles are structured-cloneable so they go in as-is;
permission is re-asked on the next visit, which is the browser's rule.

**Autosave** writes 1.2 s after the last edit, through the same snapshot function Save
uses, so a recovered document comes back with the camera where it was and a current
thumbnail — not the ones from the last explicit save. On boot the snapshot is restored
automatically; that is what an autosave is for. `?fresh` skips it, for a clean slate and
for the verification harness, which would otherwise start from whatever the last run left.
An explicit save clears the autosave, or the next boot would offer to "restore" work that
is already safely in the file. Autosave failures are reported loudly: failing quietly is
exactly how people lose work.

**Files** go through one `FileAccess` shape with two implementations. Where the File
System Access API exists (Chrome, Edge) the app gets real dialogs and a handle, so Save
overwrites the file that was opened. Elsewhere Open is a file input and Save is a
download. A third implementation, backed by a desktop shell's filesystem, slots in here
when the app is packaged; nothing above it changes.

The recent-files write is deliberately non-fatal. An open that succeeded must not be
reported as failed because a bookkeeping write could not clone a handle — which is how
the first browser test failed, on a stand-in handle made of plain functions.

## Not yet

The rollback of a bad autosave. In the browser, New and Open ask before discarding via
`window.confirm`, which is ugly and honest; the desktop shell uses a native dialog.

## Amendment: the desktop shell

The third `FileAccess` implementation is the Tauri shell, and it is deliberately thin.
The application is the web build; the process exists to give it a window, a place on
disk, and a file type. Four Rust commands are the whole surface: `parts_directory`,
`read_card`, `write_card`, `launch_file`.

**Files are referred to by path**, and a path is a plain string, so it structured-clones
into IndexedDB without the handle fallback the browser needed. `FileLocation` is now a
handle *or* a `{ path }`; each backend refuses the other's kind with a message that says
what to do instead, rather than pretending.

**The parts directory is `<Documents>/CARDstock`**, created on first use, where Open and
Save As start. Visible on purpose: parts are things people share and back up, and an
application-data folder is where files go to be lost. The application-data folder is
still used, by WebKit, for IndexedDB — autosave and recents — which is exactly what it is
for.

**Reads and writes are `std::fs`, not the filesystem plugin.** A `.card` double-clicked
anywhere on disk must open, and any plugin scope wide enough to allow that is no scope at
all. Instead the two commands accept only `.card` paths, which is the one rule that keeps
them from being a general filesystem API for the webview. Writes go to a sibling temp
file and are renamed over the target, so a crash mid-write leaves the previous save
rather than a truncated one.

**File association** is declared in the bundle config. Linux and Windows pass the opened
file as an argument; the shell stashes the first `.card` in argv and hands it over once,
through `launch_file` — consumed, so a webview reload does not reopen it over whatever the
user has since done. macOS delivers files as `RunEvent::Opened` instead. A second launch
while the app is running goes through the single-instance plugin, which forwards its
arguments to the running window as an `open-file` event; the frontend asks before
discarding, as Open does. The launch file outranks the autosave at boot: the double-click
*is* the instruction.

The frontend half is written against injected bindings (`ShellBindings`) and tested
against a fake shell; the only place the Tauri packages are imported is the production
wiring at the bottom of `tauri-files.ts`, reached by a dynamic import that the browser
build never follows. The Rust half carries its own unit tests for the two pure functions.

This machine had no Rust toolchain or GTK development headers when the shell was written,
so the Rust side was checked by eye, not by `cargo`. First build is on the developer's
machine; the prerequisites are in the README.
