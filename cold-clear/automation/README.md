# Automation Bridge

This crate turns the existing Cold Clear move planner into a Windows automation runner.

It now ships with two layers:

- a Rust runner that consumes `GameSnapshot` JSON and drives keyboard input
- a Python screen scanner that can capture a live client and emit that JSON

## What it does

- reads a `GameSnapshot` JSON file
- rebuilds a `libtetris::Board` from that snapshot
- asks Cold Clear for a move
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
- edit dry-run, timings, nodes, movement mode, spawn rule, handling, and key bindings
- start or stop the scanner + bot session
- save launcher settings for the next launch

For live TETR.IO control, the built-in presets now default to `Hard Drop Only`, which is less
ambitious than `ZeroG Complete` but much closer to what the simple key-tap driver can reproduce
reliably.

If you still want the old terminal-only behavior, pass a config path argument.

## Scanner

First calibrate the board and preview rectangles:

```powershell
python automation/scripts/calibrate_regions.py --monitor 1 --output automation/scan-config.json
```

For TETR.IO, you can usually skip manual dragging and let it auto-detect from the live screen:

```powershell
python automation/scripts/calibrate_regions.py --monitor 1 --player-side auto --auto-save --output automation/scan-config.json
```

If two boards are visible and you want the left or right one explicitly, replace `auto` with
`left` or `right`.

If you are using the same 1920x1080 TETR.IO layouts as the included reference screenshots, you can
skip calibration entirely and use the fixed presets:

```powershell
python automation/scripts/screen_scanner.py automation/scan-config.vs-left-1080p.json
```

```powershell
python automation/scripts/screen_scanner.py automation/scan-config.solo-1080p.json
```

`automation/scan-config.json` currently defaults to the 2-player left-side 1080p layout.

## Packaging Note

The launcher exe is now windowed, but the live scanner still runs through the bundled Python script
`automation/scripts/screen_scanner.py`. So for a true single-file distribution, the next step would
be either:

- bundle Python together with the release package, or
- port the scanner from Python into Rust later

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

The scanner writes `automation/live-snapshot.json` by default. Point the Rust runner at that file
by changing `snapshot_path` in `automation/config.example.json`.

## How the scanner works

- reads a calibrated board rectangle and samples each cell center
- trims disconnected components so a freshly spawned floating piece is usually excluded from the stack
- classifies hold/preview boxes by dominant color against a configurable piece palette
- detects the active piece from either a dedicated active slot or a spawn zone above the board
- falls back to previous preview-queue shift inference when the active piece is not directly visible
- emits a new snapshot only after the preview queue is stable for a few frames

The live input side now rebuilds a route from the planned `expected_location` using the same
SRS rotation/kick logic as `libtetris`, instead of replaying Cold Clear's internal movement list
directly. The current handling settings especially affect whether soft-drop steps are allowed:
`soft_drop_mode = infinite` disables stepped soft-drop routing, while `step` allows tucks that
need explicit downward inputs.

## Practical notes

- The scanner assumes a fairly standard colored skin. If your client uses a custom skin, update the
  `piece_palette` in `automation/scan-config.json`.
- If you do not calibrate an `active_slot`, the very first piece after startup may be skipped. After
  that, the scanner can infer the active piece from the queue shift. For TETR.IO, calibrating `p`
  as a spawn zone above the matrix is the better default.
- TETR.IO solo and versus both commonly spawn the current piece above the visible matrix. The
  scanner now supports a `spawn_zone` rectangle for that case, and also has an automatic board-based
  fallback zone if you do not draw one manually.
- The calibrator can auto-detect the board and derive hold/next/spawn rectangles from it. In most
  standard TETR.IO layouts that is enough without dragging every box by hand.
- `debug_output_path` saves an annotated frame each time a snapshot is emitted, which helps a lot
  when tuning colors and rectangles.
- `combo`, `b2b`, and `incoming` are currently emitted as `0/false/0`. That is enough to play, but
  defensive choices will improve if you later add those signals.

## Real-client scope

For a real client such as TETR.IO or Jstris, the remaining tuning is:

- field cells
- hold
- active piece or reliable queue-shift inference
- preview queue
- optional incoming garbage
