# Hosted group chat implementation

- created: 2026-09-18
- updated: 2026-09-18
- status: verified
- preparation: `docs/ic-prepare/2026-09-18-group-chat-peer-bus.md` (gitignored locally; decisions copied below)
- workspace hash (sha256 of listed files, then hashed): `92167a1116db117c53340504603d6760a137dd933461951fdc3f4d2e65ef7e3f`
- files: `src/group-chat/*`, `src/index.ts`, `src/agent-runner.ts`, `src/agent-manager.ts`, `test/group-chat.test.ts`, `docs/group-chat.md`, `README.md`, `AGENTS.md`

## Target

Replace cwd-wide `/room` intercept (bare text woke every member, skipped the main model) with session-bound `/chat on`: host = main model, seats 1–6, tell/handoff bus, FIFO queue, cancel/abort.

## What landed

- `/chat on <types>` / `/chat off`; `/room create|list|leave|status`
- Session binding (`roomBinding` + `subagents:room` entry). `/new` clears it. No cwd `active.json`.
- Bare text → host continues. `@seat` → seats only (`handled`). `@everyone` → all seats.
- Tools: `RoomEnsure`, `RoomLeave`, `room_tell`, `handoff`, `room_cancel`; seats also get `room_say` / `room_pass` via `customTools`
- Hop cap 3; self-handoff refused; busy seats queue
- Seat spawn/resume retries twice on anything except user-stop / policy refusal (500ms then 1s)
- ACP `@acp-*` not swallowed (host still runs when no seat @)
- ACP is not a seat

## Deviations from prepare

- Host tools are registered globally (`room_tell` / `handoff` / `room_cancel` on the main tool set). Seats re-admit those names via `customTools`. Nested agents still exclude them unless injected.
- Seat `room_say` also appends to disk log from the tool (in addition to drain writing the model’s final text). Duplicate say lines possible if the model both tools and returns prose.
- `handoff` does not force-end the model turn (no terminate). Prompt tells the seat to stop narrating.
- CHANGELOG.md is absent in this worktree (gitignored or never present); user-facing notes are README + `docs/group-chat.md`.

## Verification

```text
npx vitest run test/group-chat.test.ts
  1 file, 11 passed

npx vitest run test/acp-wiring.test.ts test/agent-mention-wiring.test.ts test/rpc-lifecycle-gating.test.ts test/group-chat.test.ts
  4 files, 91 passed

npm run check
  lint: 267 files, no issues
  typecheck: passed
  test: 153 files passed, 1 skipped; 3097 passed, 8 skipped
```

No live Pi TUI session. Queue/cancel/abort covered in unit enqueue + abort host seam, not a full FleetView click.

## Rollback

`/chat off` or ignore `/chat`. Old `active.json` is no longer read.
