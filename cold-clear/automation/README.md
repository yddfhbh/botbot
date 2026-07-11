# Automation Bridge

This crate runs Cold Clear against TETR.IO snapshots inside `automation/live-snapshot.json`.

- `WebSocket Seed` is the default VS/private room direction.
- `Browser CDP Direct` is for solo/custom solo and direct-state debugging.
- `File` is for fixture/replay/debug workflows.
- There is no automatic fallback from `Browser CDP Direct` or `WebSocket Seed` into any image-based legacy path.
- Use only in private/solo/custom practice, not public matchmaking.

## Provider Policy

### VS WebSocket Seed

Use this for private/custom `1v1` rooms.

- reads game options from the TETR.IO websocket
- reconstructs current and queue from the captured `7-bag` seed
- keeps `incoming = 0`
- `garbage support = unsupported`
- does not depend on screen scanning

This is the recommended default for VS work in this repo.

### Solo Browser CDP - Known Good

Use this for solo/custom solo and Browser CDP debugging.

- reads direct page state through CDP
- uses a startup-only debugger capture to grab the game object once without re-probing during play
- stays separate from the VS seed path

### File Debug

Use this for fixture/replay/debug work.

- reads the snapshot file as-is
- does not launch a browser helper

## Runner

```powershell
cargo run -p automation -- automation/config.example.json
```

`config.example.json` is the real-input `Solo Browser CDP - Known Good` profile.

If you want logging only with no real input:

```powershell
cargo run -p automation -- automation/config.dry-run.example.json
```

VS/private room example:

```powershell
cargo run -p automation -- --snapshot-provider websocket_seed --input-backend browser_cdp --cdp-port 9222 --url https://tetr.io/ --target TETR.IO
```

Solo/debug example:

```powershell
cargo run -p automation -- --snapshot-provider browser_cdp --input-backend browser_cdp --cdp-port 9222 --url https://tetr.io/ --target TETR.IO
```

File debug example:

```powershell
cargo run -p automation -- --snapshot-provider file
```

`dry_run: true` leaves input untouched and logs that input is being skipped.

## Launcher

```powershell
cargo run -p automation
```

The launcher exposes four modes:

- `VS WebSocket Seed`
- `Solo Browser CDP - Known Good`
- `File Debug`
- `Custom`

Recommended usage:

1. Pick `VS WebSocket Seed` for private/custom `1v1` rooms.
2. Pick `Solo Browser CDP - Known Good` for solo/custom solo.
3. Leave `Scan Code` and `Virtual Key` as fallback input backends only when `Browser CDP` input is not usable.

When `WebSocket Seed` is selected, the launcher shows:

- `Seed captured`
- `bagtype`
- `nextcount`
- `pieceIndex`
- `current`
- `queue`
- `local board hash`
- `garbage support`

These values come from `automation/live-snapshot.json`.

## Failure Policy

- `Browser CDP Direct` failure returns `ok:false` with a reason and optional dump.
- `WebSocket Seed` failure returns `ok:false` with a reason and websocket helper logs.
- Neither provider automatically starts any legacy image-based fallback.
- `File` mode is the only path that consumes an externally written snapshot directly.

## Browser CDP Notes

- `Debugger probe mode=startup_only` is the recommended solo default.
- `Browser CDP Direct` is a solo/debug path, not the default VS path.
- If direct-state capture fails in VS, switch to `WebSocket Seed`; do not work around it by reviving scanner fallbacks.

## Legacy Screen Scanner

The screen scanner is legacy/debug only. It is not a recommended preset, not a VS default path, and not an automatic fallback.

Do not work on scanner unless explicitly requested.
