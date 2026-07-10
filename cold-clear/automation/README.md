# Automation Bridge

This crate turns the Cold Clear planner into a Browser CDP driven TETR.IO automation runner.

- Browser CDP mode is the recommended mode for TETR.IO solo/custom practice.
- Screen scanner support has been removed from the launcher and runtime flow.
- Browser mode avoids color recognition errors and many Windows foreground `SendInput` issues.
- Use only in private/solo/custom practice, not public matchmaking.

Jstris extension bots avoid OS focus by dispatching DOM KeyboardEvents, but TETR.IO desktop cannot rely on that; use conservative SendInput timing instead. In browser mode this project now prefers conservative CDP key dispatch with the same timing philosophy.

## What It Does

- reads TETR.IO state from a Chromium tab through CDP
- writes the live state into `automation/live-snapshot.json` as internal transport
- rebuilds a `libtetris::Board` from that snapshot
- asks Cold Clear for a move
- executes a `ZeroG Safe` route by default so spins remain available
- falls back to `Hard Drop Only` only when no safe executable route exists

## Runner

```powershell
cargo run -p automation -- automation/config.example.json
```

```powershell
cargo run -p automation -- --input-backend browser_cdp --cdp-port 9222 --url https://tetr.io/ --target TETR.IO
```

`dry_run: true` leaves the keyboard untouched and only prints planned actions.

## Launcher

```powershell
cargo run -p automation
```

Running without arguments opens the launcher. The launcher is now Browser CDP only.

- choose `2P Left 1080p`, `Solo 1080p`, or `Custom`
- set Chrome path, CDP port, URL, and target hint
- toggle page probing, ribbon websocket capture, and seed simulation fallback
- tune dry-run, target PPS, tap timings, and planner limits
- start or stop the bot session

## TETR.IO Safe preset

The built-in presets now target a faster Browser CDP setup for personal practice.

- `Snapshot transport`: internal `live-snapshot.json`
- `Input backend`: `Browser CDP`
- `URL`: `https://tetr.io/`
- `CDP Port`: `9222`
- `Target`: `TETR.IO`
- `Movement`: `ZeroG Safe`
- `Spawn`: `Row 19 or 20`
- `Planner threads`: `1`
- `Planner min nodes`: `50`
- `Planner max nodes`: `800`
- `Target PPS`: `0.0` (`0 = unlimited`)
- `Poll`: `2ms`
- `Move Tap`: `12ms`
- `Rotate Tap`: `14ms`
- `HardDrop Tap`: `16ms`
- `Move Delay`: `0ms`
- `Rotate Delay`: `0ms`
- `HardDrop Delay`: `0ms`
- `Piece Delay`: `0ms`
- `Min Snapshot Age`: `0ms`
- `IRS/IHS`: `Off`
- `Speculate`: `Off`
- `Allow spin routes`: `On`
- `Allow post-softdrop horizontal`: `Off`
- `Release after each action`: `Off`
- `Action settle`: `0ms`

If you need a simpler emergency path, switch `Movement` to `Hard Drop Only`.

`ZeroG Complete` is still available, but it should be treated as `Advanced/Experimental`.

## Speed Notes

If the bot still feels capped around low PPS, the likely bottleneck is planner cost rather than tap delay.

- lower `Planner min nodes` and `Planner max nodes` first
- keep `Target PPS` at `0` while testing raw speed
- keep `Use hold` on for strength, but turn it off temporarily if you only want a speed ceiling test
- watch the log line with `planner=... elapsed_ms=...`

## Browser CDP Mode

Browser CDP mode attaches to Chromium launched with `--remote-debugging-port=9222`, or connects to an already running browser on that port.

- `Probe page state`: reads the live board/current/hold/queue directly from the page when possible
- `Use ribbon websocket`: captures ribbon metadata such as seed/options when available
- `Use seed simulation fallback`: reconstructs queue state when direct page data is incomplete

The runtime will not input while `playing=false` or `countdown=true`, and it skips duplicate `pieceCounter` values.
