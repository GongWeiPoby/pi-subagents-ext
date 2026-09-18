# Group Chat (Rooms) MVP

Named multi-member rooms for long-lived collaboration. **Not** the same as
`group-join.ts` (that only batches completion notifications).

## Quick start

```text
/room create 技术中台开发小组 --members Explorer,Worker
```

Replace `Explorer,Worker` with agent types from `.pi/agents/*.md` (or global
agents). The room becomes **active** immediately.

Then type normally in the TUI:

| Input | Behavior |
|---|---|
| `大家看一下网关超时问题` | Wake **all** members (serial turns) |
| `@explorer 先查日志` | Wake **mentioned** only; full text still stored |
| `/room leave` | Exit room mode (input goes to main again) |

## Commands

| Command | Action |
|---|---|
| `/room create <name> --members <type>[,<type>…]` | Create + enter |
| `/room list` | List rooms |
| `/room switch <name\|id>` | Enter an existing room |
| `/room leave` | Clear active room |
| `/room status` | Active room + recent transcript |

## Product rules (locked)

1. **No `@`** → wake **all** members.
2. **`@handle`** → wake **mentioned** members only; always append the **full** user text to the room transcript.
3. When a room is **active**, the extension performs **direct fan-out** and returns `handled` — the **main model is bypassed**.
4. Member turns are **serial** (one finishes before the next starts).
5. Implemented under `src/group-chat/` — does **not** overload `group-join`.

## Persistence

```text
.pi/groups/index.json                 # activeRoomId
.pi/groups/<roomId>/meta.json         # name, members, bindings
.pi/groups/<roomId>/transcript.jsonl  # append-only messages
```

Each member still has a normal subagent session (spawn / resume / steer via
`AgentManager`). Room posts are the replies captured after each serial turn.

## Tools

| Tool | Purpose |
|---|---|
| `room_read` | Read recent room transcript |
| `room_post` | Append a note as main (does not wake members) |

## Relation to `@handle` mentions

Outside a room, leading `@handle message` keeps the existing Claude Code-style
delegation behavior (steer / resume / start). Inside an active room, **all**
non-slash input is room chat, including inline `@handle` wake selection.
