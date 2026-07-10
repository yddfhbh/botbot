# Automation Bridge

This crate turns the existing Cold Clear move planner into a Windows automation runner.

It ships with two layers:

- a Rust runner that consumes `GameSnapshot` JSON and drives keyboard input
- a Browser CDP source that reads TETR.IO state from a Chromium tab
- a Python screen scanner kept only as fallback/debug input

Browser CDP mode is now the recommended mode for TETR.IO solo/custom practice.
Screen scanner is fallback/debug only.
Browser mode avoids color recognition errors and Windows foreground `SendInput` issues.
Use only in private/solo/custom practice, not public matchmaking.

Jstris extension bots avoid OS focus by dispatching DOM KeyboardEvents, but TETR.IO desktop cannot
rely on that; use conservative CDP/browser input or conservative `SendInput` timing instead.

## What it does

- reads a `GameSnapshot` JSON file
- can produce snapshots from `browser_cdp`, `scanner`, or `file`
- rebuilds a `libtetris::Board` from that snapshot
- asks Cold Clear for a move
- reduces `Hard Drop Only` execution to spawn-based rotations + left/right tap counts + hard drop
- sends the resulting inputs with Browser CDP or conservative `SendInput`

## Snapshot contract

The scanner must write a JSON object like `sample-snapshot.json`.

- `token`: unique id for the current piece state; the runner only acts when this changes
- `field`: 40 rows of 10 booleans, bottom row first
- `queue`: the active piece first, then visible previews
- `hold`: current hold piece or `null`
- `combo`, `b2b`, `incoming`: optional state carried into evaluation

## Runner

```powershell
cargo run -p automation -- automation/config.example.json
```

```powershell
cargo run -p automation -- --snapshot-provider browser_cdp --input-backend browser_cdp
```

`dry_run: true` leaves the keyboard untouched and only prints the planned actions.
That path uses `DebugLogBackend`; live play now defaults to `BrowserCdpInputBackend` and can fall
back to `SendInputScanCodeBackend` or `SendInputVirtualKeyBackend` if needed.

## Launcher UI

```powershell
cargo run -p automation
```

Running without arguments opens the launcher window. From there you can:

- choose `2P Left 1080p`, `Solo 1080p`, or `Custom`
- choose `Browser CDP`, `Screen Scanner`, or `File` as the snapshot provider
- edit Browser CDP connection fields such as Chrome path, port, URL, target hint, and ribbon/seed fallbacks
- edit dry-run, timings, nodes, movement mode, spawn rule, handling, input backend, and key bindings
- start or stop the bot session
- save launcher settings for the next launch

## TETR.IO Safe preset

The built-in live presets now apply a `TETR.IO Safe preset` aimed at personal solo / practice testing.

- `Snapshot provider`: `Browser CDP`
- `Input backend`: `Browser CDP`
- `URL`: `https://tetr.io/`
- `CDP Port`: `9222`
- `Target`: `TETR.IO`
- `Movement`: `Hard Drop Only` by default
- `Spawn`: `Row 19 or 20`
- `Legacy Tap`: `60ms`
- `Move Tap`: `55ms`
- `Rotate Tap`: `70ms`
- `HardDrop Tap`: `80ms`
- `Move Delay`: `60ms`
- `Rotate Delay`: `120ms`
- `HardDrop Delay`: `100ms`
- `Piece Delay`: `100ms`
- `Min Snapshot Age`: `40ms`
- `IRS/IHS`: `Off`
- `Prevent accidental hard drops`: `On`
- `Speculate`: `Off`
- `SoftDrop route`: disabled when `soft_drop_mode = infinite`

If you want a slightly more flexible route search without going all the way to experimental handling,
switch `Movement` to `ZeroG Safe`.

`ZeroG Complete` is still available, but it should be treated as `Advanced/Experimental`. Use it only
when the logged input route is something the real client can actually reproduce.

## Replay-calibrated input profile

These defaults are tuned to match longer real TETR.IO tap windows instead of the old `18ms` single-tap
profile:

- `Movement Tap`: `55ms`
- `Rotate Tap`: `70ms`
- `HardDrop Tap`: `80ms`
- `Move Delay`: `60ms`
- `Rotate Delay`: `120ms`
- `HardDrop Delay`: `100ms`
- `Piece Delay`: `100ms`
- `Snapshot provider`: `Browser CDP`
- `Input backend`: `Browser CDP`
- `Movement`: `Hard Drop Only`
- `Spawn`: `Row 19 or 20`
- `IRS/IHS`: `Off` first, then experiment with tap buffering only after the base profile is stable

Movement taps are clamped below DAS with a safety margin, while rotate / hard drop keep their own
dedicated press lengths. The launcher keeps `Legacy Tap` as a fallback, but the runtime now prefers
the action-specific tap fields and the separate inter-action delay preset.

## If inputs still feel unstable

Try these first:

- `Movement`: `Hard Drop Only` or `ZeroG Safe`
- `Spawn`: `Row 19 or 20`
- `Move Tap`: start at `55ms`
- `Rotate Tap`: start at `70ms`
- `HardDrop Tap`: start at `80ms`
- `Move Delay`: start at `60ms`
- `Rotate Delay`: start at `120ms`
- `HardDrop Delay`: start at `100ms`
- `Piece Delay`: start at `100ms`
- `IRS/IHS`: `Off`
- `Prevent accidental hard drops`: `On`
- `Input backend`: keep `Browser CDP` first and only fall back to `Scan Code (SendInput)` or `Virtual Key (SendInput)` if needed
- `SoftDrop route`: keep it disabled for Infinite SDF clients like TETR.IO

The runner now also forces `release_all_keys()` before a plan, after hold, before hard drop, after hard
drop, and again when the launcher stops. In `Hard Drop Only`, the executor never uses DAS-hold movement:
it only replays spawn-based rotations, left/right tap counts, and hard drop. After locking, the runner
waits until the scanner reports a changed current/queue state that has stayed stable for two frames before
starting the next piece.

## Browser CDP mode

Browser CDP mode attaches to a Chromium tab opened with `--remote-debugging-port=9222` or launches one
for you. It probes TETR.IO page state first, optionally watches the ribbon WebSocket for seed/options,
and can fall back to seed-based 7-bag reconstruction before falling all the way back to the screen scanner.

Recommended Browser CDP defaults:

- `Provider`: `Browser CDP`
- `Input backend`: `Browser CDP`
- `URL`: `https://tetr.io/`
- `CDP Port`: `9222`
- `Target`: `TETR.IO`
- `Probe page state`: `On`
- `Use ribbon websocket`: `On`
- `Use seed simulation fallback`: `On`

## Scanner

Screen scanner is still available, but it is intended for fallback/debug use now.

First calibrate the board and preview rectangles:

```powershell
python automation/scripts/calibrate_regions.py --monitor 1 --output automation/scan-config.json
```

For TETR.IO, you can usually skip manual dragging and let it auto-detect from the live screen:

```powershell
python automation/scripts/calibrate_regions.py --monitor 1 --player-side auto --auto-save --output automation/scan-config.json
```

If two boards are visible and you want the left or right one explicitly, replace `auto` with `left`
or `right`.

If you are using the same 1920x1080 TETR.IO layouts as the included reference screenshots, you can
skip calibration entirely and use the fixed presets:

```powershell
python automation/scripts/screen_scanner.py automation/scan-config.vs-left-1080p.json
```

```powershell
python automation/scripts/screen_scanner.py automation/scan-config.solo-1080p.json
```

`automation/scan-config.json` currently defaults to the 2-player left-side 1080p layout.

Keys inside the calibrator:

- `r`: auto-detect layout again from the current frame
- `b`: board
- `h`: hold
- `a`: active piece slot if you have one
- `p`: spawn zone above the board for games like TETR.IO
- `1` to `5`: next queue slots
- drag with the mouse to assign the active mode
- `s`: save
- `q`: quit

Then start the live scanner:

```powershell
python automation/scripts/screen_scanner.py automation/scan-config.json
```

The scanner writes `automation/live-snapshot.json` by default. Point the Rust runner at that file by
changing `snapshot_path` in `automation/config.example.json`.

## How the scanner works

- reads a calibrated board rectangle and samples each cell center
- trims disconnected components so a freshly spawned floating piece is usually excluded from the stack
- classifies hold/preview boxes by dominant color against a configurable piece palette
- detects the active piece from either a dedicated active slot or a spawn zone above the board
- falls back to previous preview-queue shift inference when the active piece is not directly visible
- emits a new snapshot only after the preview queue is stable for a few frames

## Practical notes

- The scanner assumes a fairly standard colored skin. If your client uses a custom skin, update the
  `piece_palette` in `automation/scan-config.json`.
- If you do not calibrate an `active_slot`, the very first piece after startup may be skipped. After
  that, the scanner can infer the active piece from the queue shift. For TETR.IO, calibrating `p` as
  a spawn zone above the matrix is the better default.
- TETR.IO solo and versus both commonly spawn the current piece above the visible matrix. The
  scanner supports a `spawn_zone` rectangle for that case, and also has an automatic board-based
  fallback zone if you do not draw one manually.
- `debug_output_path` saves an annotated frame each time a snapshot is emitted, which helps a lot
  when tuning colors and rectangles.
- `combo`, `b2b`, and `incoming` are currently emitted as `0/false/0`. That is enough to play, but
  defensive choices will improve if you later add those signals.
