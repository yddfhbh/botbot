# Automation Bridge

This crate turns the existing Cold Clear move planner into a Windows automation runner.

It ships with two layers:

- a Rust runner that consumes `GameSnapshot` JSON and drives keyboard input
- a Python screen scanner that can capture a live client and emit that JSON

## What it does

- reads a `GameSnapshot` JSON file
- rebuilds a `libtetris::Board` from that snapshot
- asks Cold Clear for a move
- rebuilds a safe route to `expected_location`
- sends the resulting inputs with `SendInput`

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

`dry_run: true` leaves the keyboard untouched and only prints the planned actions.

## Launcher UI

```powershell
cargo run -p automation
```

Running without arguments opens the launcher window. From there you can:

- choose `2P Left 1080p`, `Solo 1080p`, or `Custom`
- edit dry-run, timings, nodes, movement mode, spawn rule, handling, input backend, and key bindings
- start or stop the scanner + bot session
- save launcher settings for the next launch

## TETR.IO Safe preset

The built-in live presets now apply a `TETR.IO Safe preset` aimed at personal solo / practice testing.

- `Movement`: `Hard Drop Only` by default
- `Spawn`: `Row 19 or 20`
- `Tap`: `18ms`
- `Settle`: `10ms`
- `Pre Hard Drop Delay`: `20ms`
- `Post Hard Drop Delay`: `50ms`
- `Post Move Cooldown`: `50ms`
- `Min Snapshot Age`: `20ms`
- `IRS/IHS`: `Off`
- `Prevent accidental hard drops`: `On`
- `SoftDrop route`: disabled when `soft_drop_mode = infinite`

If you want a slightly more flexible route search without going all the way to experimental handling,
switch `Movement` to `ZeroG Safe`.

`ZeroG Complete` is still available, but it should be treated as `Advanced/Experimental`. Use it only
when the logged input route is something the real client can actually reproduce.

## If inputs still feel unstable

Try these first:

- `Movement`: `Hard Drop Only` or `ZeroG Safe`
- `Spawn`: `Row 19 or 20`
- `Tap`: `16-24ms`
- `Settle`: `8-15ms`
- `IRS/IHS`: `Off`
- `Prevent accidental hard drops`: `On`
- `Input backend`: switch from `Virtual Key` to `Scan Code`
- `SoftDrop route`: keep it disabled for Infinite SDF clients like TETR.IO

The runner now also forces `release_all_keys()` before a plan, after hold, before hard drop, after hard
drop, and again when the launcher stops. Hard drop is executed in its own phase with configurable
pre/post delays, and the next token is guarded by snapshot age plus a short post-move cooldown.

## Scanner

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
