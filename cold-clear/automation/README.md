# Automation Bridge

This crate turns the Cold Clear planner into a Browser CDP snapshot driven TETR.IO automation runner.

- Browser CDP snapshot mode is the recommended way to read TETR.IO state.
- `WebSocket Seed` is an experimental VS room snapshot provider that only reconstructs `current` / `queue`.
- Screen scanner support has been removed from the launcher and runtime flow.
- `Scan Code` is the default input backend on Windows because it avoids Browser CDP input stalls while keeping CDP state reads.
- `Browser CDP` input remains available when foreground `SendInput` is unreliable.
- Use only in private/solo/custom practice, not public matchmaking.

## What It Does

- reads TETR.IO state from a Chromium tab through CDP
- writes the live state into `automation/live-snapshot.json` as internal transport
- rebuilds a `libtetris::Board` from that snapshot
- asks Cold Clear for a move
- uses a stability-first preset by default

## Runner

```powershell
cargo run -p automation -- automation/config.example.json
```

```powershell
cargo run -p automation -- --input-backend scan_code --cdp-port 9222 --url https://tetr.io/ --target TETR.IO
```

```powershell
cargo run -p automation -- --snapshot-provider websocket_seed --input-backend scan_code --cdp-port 9222 --url https://tetr.io/ --target TETR.IO
```

`dry_run: true` leaves the keyboard untouched and only prints planned actions.

## Launcher

```powershell
cargo run -p automation
```

Running without arguments opens the launcher.

- choose `2P Left 1080p`, `Solo 1080p`, or `Custom`
- choose `Browser CDP Direct`, `WebSocket Seed`, or `File`
- choose `Scan Code`, `Virtual Key`, or `Browser CDP` for input
- set snapshot path, Chrome path, CDP port, URL, and target hint
- choose `Player` selector plus optional nickname / user id when using VS rooms
- tune `Browser state poll ms`, `Debugger probe mode`, `Ribbon decode mode`, `Input focus mode`, planner limits, and `Perf log`
- use `Stable`, `Fast but risky`, or `Benchmark`
- `Capture game object` manually triggers the debugger probe once

## Stable Preset

The default preset now favors stability over raw throughput.

- `Snapshot provider`: `Browser CDP Direct`
- `Input backend`: `Scan Code`
- `Movement`: `ZeroG Safe`
- `Spawn`: `Row 19 or 20`
- `Target PPS`: `1.2`
- `Runner poll`: `20ms`
- `Browser state poll`: `40ms`
- `Browser min state poll`: `16ms`
- `Min Snapshot Age`: `30ms`
- `Planner threads`: `1`
- `Planner min nodes`: `0`
- `Planner max nodes`: `100000`
- `Debugger probe mode`: `startup_only`
- `Ribbon decode mode`: `until_seed`
- `Use ribbon websocket`: `Off`
- `Use seed simulation fallback`: `Off`
- `Input focus mode`: `per_plan`
- `Move Delay`: `20ms`
- `Rotate Delay`: `30ms`
- `HardDrop Delay`: `40ms`
- `Piece Delay`: `60ms`
- `ZeroG Complete` remains available as `Advanced/Experimental`
- `Hard Drop Only` remains available as an emergency fallback

## Fast But Risky

- `Runner poll`: `16ms`
- `Browser state poll`: `16ms`
- `Planner threads`: `2`
- `Planner max nodes`: `200000`

## Benchmark

- `Runner poll`: `2ms`
- `Planner threads`: `4`
- `Planner max nodes`: `400000`

`Poll 2ms` is for debug / benchmark use only and should not be your default.

## Speed Notes

- If the TETR.IO screen freezes every 2 seconds, check whether the debugger probe is repeating.
- Do not leave debugger breakpoint probing enabled during live play.
- Browser CDP `Runtime.evaluate` usually only needs to run every `30-60ms`.
- `Poll 2ms` is for debug / benchmark use only, not a recommended default.
- When performance is bad, start testing from `threads=1` and `max_nodes=100000`.
- If `cdp_eval_ms` spikes and `input_ms` jumps together, keep the snapshot provider on `Browser CDP Direct` and switch only the input backend to `Scan Code` first.

## Browser CDP Mode

- `Probe page state`: reads the live board/current/hold/queue directly from the page when possible
- `Debugger probe mode=startup_only`: allows the heavy `Debugger` probe only until the game object is first captured
- `Debugger probe mode=manual`: only the launcher button or one-off CLI probe can run it
- `Debugger probe mode=disabled`: never uses the debugger probe
- `Ribbon decode mode=until_seed`: decode only received ribbon frames until the seed is found

The runtime will not input while `playing=false` or `countdown=true`, and it skips duplicate tokens.

## VS Room

Browser CDP VS room settings:

```json
{
  "browser": {
    "player_selector": "auto",
    "player_nickname": "hebi_",
    "player_user_id": "",
    "dump_state_on_fail": true,
    "dump_state_path": "automation/debug/tetrio-state-dump.json"
  }
}
```

- `player_selector=auto` first prefers `isLocal`/`local` style flags, then user id, then nickname, then the first alive candidate with a current piece
- `player_selector=left` or `right` forces index `0` or `1` among valid player candidates
- `player_selector=nickname` and `user_id` only select exact matches
