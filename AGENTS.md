# AGENTS.md — repo map for a coding agent

Read this before your first edit. It is the map of the repository, written for an
agent working on someone's fork. The human-facing docs are `README.md` (English)
and `README.ru.md` (Russian); this file is the part they don't need to read.

## What this is

A personal MCP server: a public HTTP endpoint where other people's agents read
the owner's context files and leave the owner a message. No authentication by
design — the read layer is public. One codebase serves as both a working
reference deployment and a template to fork.

## The one boundary that matters

**Nothing personal goes in the code.** Not a name, not a domain, not a pronoun.

- `context/` — the owner's personal layer, **never committed** (`.gitignore`).
  Inside: `*.md` (what the tools serve), `config.json` (name, domain, caps,
  description overrides), `deploy.env` (server address, domain, docker names).
- `context.example/` — the same shape with placeholders, and it **is** committed.
  Change the shape of the personal layer and you update both, or a fork gets a
  template that doesn't match the code.
- `src/`, `test.js`, `Dockerfile`, `docker-compose.yml` contain nothing personal.
  A test enforces this (`в коде нет ничего личного` in `test.js`). If you need a
  name, a domain or a pronoun, read it from the config — do not type it into the
  code.

Secrets live in environment variables only, and on the deployment host. Never in
the repo, never in `context/`, never in a commit.

## Stack and constraints

- Node 22 (`node:22-slim`), ESM, express 4.
- **MCP SDK v2**: `@modelcontextprotocol/server` + `@modelcontextprotocol/node`.
  The 1.x monolith `@modelcontextprotocol/sdk` is not used.
- Exactly two dependencies (express and the SDK). No ORM, no database, no SMTP
  client — outbound mail is a plain `fetch` to Resend's HTTP API. Adding a
  dependency is a decision, not a convenience; don't make it silently.
- State is three files on disk (`data/journal.jsonl`, `data/inbox.jsonl`,
  `data/budget.json`), kept in a docker volume in production. No sessions: the
  MCP handler is created per request and closed in `finally`.

## Layout

```
context/          personal layer (not in git): *.md + config.json + deploy.env
context.example/  the same as a template (committed)
src/config.js     defaults → context/config.json → env (env always wins)
src/context.js    the owner's files → sections and the tool list
src/mcp.js        the protocol: tool assembly, schemas, journal, mounting /mcp
src/lib.js        state on disk, budget cap, validation, Anthropic + notifications
src/discovery.js  server-card.json and llms.txt built from the config
src/server.js     express, client IP behind a proxy, rate-limit buckets, startup
test.js           node:test over test/fixtures/ — 50 tests, all network mocked
data/             journal.jsonl, inbox.jsonl, budget.json (not in git)
```

Entry points: `src/server.js` (the process), `mountMcp()` in `src/mcp.js` (the
protocol), `buildTools()` in the same file (which tools exist), `loadContext()`
in `src/context.js` (files → sections).

## Tools are assembled, not listed

**No file, no tool.** Delete `context/speaking.md` and `get_speaking` disappears
from `tools/list` rather than returning an empty string. Add `context/reading.md`
and `get_reading` appears with no code change. The file → tool map and the tool
order come from `config.json → context.groups`; a `tool:` key in a file's YAML
header overrides it.

`ask` is declared only when `ask.enabled` (off in the template — it is the only
tool that costs money). `leave_message` is always declared.

Descriptions of file tools come from `for_agent` in each file's own header;
descriptions of `ask` and `leave_message` come from `config.json → tools`. The
description lives next to the content it describes, so the two cannot drift.

## Two protocol eras on one endpoint

`createMcpHandler` serves both, from one `buildServer(ctx)` factory:

- **modern 2026-07-28** — no `initialize`; version, client and capabilities ride
  in a per-request `_meta` envelope, method and tool name are mirrored in the
  `Mcp-Method` / `Mcp-Name` headers (SEP-2243), overview via `server/discover`.
  Response is JSON.
- **legacy 2025-era** — ordinary `initialize`, SDK ceiling 2025-11-25. Response
  is an **SSE frame**, not JSON (the SDK v2 stateless path). This breaks no
  client: a 200 only ever went to a caller that declared
  `Accept: text/event-stream`; without it, 406, as before.

The server card carries **two** version fields and each means something
different: `protocolVersion` is what `initialize` actually answers (taken from
the SDK's `LATEST_PROTOCOL_VERSION`), `protocolVersions` lists both eras, modern
first. One scalar cannot describe a two-era server. `MODERN_PROTOCOL_VERSION` is
the only literal, because the SDK does not export it. Four tests cover this —
they boot the server and diff the card against a live `initialize` and
`server/discover`. Don't replace them with a hand-check.

## Run and verify

```bash
npm test                                          # 50 tests, network mocked
PORT=3999 DATA_DIR=/tmp/mcp node src/server.js    # local server on context/
CONTEXT_DIR=test/fixtures/context-lite node src/server.js   # lite: one file
```

A live handshake is checked with the official client
(`@modelcontextprotocol/client`), each era separately:
`versionNegotiation: { mode: 'auto' }` must report `era: modern`, a bare
constructor `era: legacy`. Both must return the same tool list.

A hand-written curl in the modern era without `Mcp-Method` / `Mcp-Name` gets
`-32020`. That is the correct answer, not a breakage.

**If you change what an agent sees, capture "before" and "after" with a real MCP
client**, not with curl: both eras, the full `tools/list`, and the output of
every file tool. Exercise `ask` and `leave_message` only along paths with no side
effects (empty question, bad arguments) — a real `leave_message` writes to the
inbox and pushes a notification.

## Deploy

`./deploy.sh`: tests → preview of what would be deleted on the host (a gate in
front of `rsync --delete`) → rsync of the working tree → `docker compose up -d
--build` → smoke test. The destination is not in the script: `DEPLOY_SERVER`,
`DEPLOY_DIR`, `MCP_PUBLIC_URL` and the docker names all come from
`context/deploy.env`.

`.env` and `data/` are excluded — secrets and the journal live on the host only.
`context/` is **not** excluded and must not be: it is the content of the server.

Rollback: production holds no git checkout, the working tree is what ships. So
`git checkout <previous-commit> && ./deploy.sh`, then return to your branch. The
journal volume is untouched by this. `context/` is not in git, so rolling back
the code does not roll back the context.

## Traps

- **Context is read at process start.** Editing `context/*.md` without a restart
  changes nothing.
- **`.env` is edited on the host, not here.** With no `ANTHROPIC_API_KEY`, `ask`
  refuses politely; with no notification channel, the push is skipped silently
  and the message still lands in `data/inbox.jsonl`. The legacy `TG_BOT_TOKEN` /
  `TG_CHAT_ID` names are supported alongside `NOTIFY_TG_*` so that servers
  deployed before the rename keep working — don't drop them.
- **The volume name is written out in full in `deploy.env`
  (`MCP_VOLUME_NAME`), without a compose project prefix.** Rename it and compose
  creates a new empty volume; the journal and inbox stay in the old one.
- **The traefik router for `/mcp` is a `PathPrefix` with a high priority.** It
  will also swallow paths like `/mcp.html` on the same domain. If a site serves
  those, it needs its own router with a higher priority, and both invariants
  belong in that site's smoke test.
- **The daily `ask` caps are money-safety**, not tidiness: state in
  `data/budget.json` survives restarts, numbers come from
  `context/config.json → ask`. Per-IP limits alone are not enough — IP addresses
  are free for an agent.
- **Discovery can be disabled** (`discovery.enabled: false`) when the owner's
  site already serves `.well-known/mcp/server-card.json` and `llms.txt` on the
  same domain. Two sources of truth are worse than one — if both exist, they must
  agree, and the card must match what the live handshake answers.

## House rules

- Conventional commits, English, lowercase.
- Don't rewrite files you weren't asked to touch. One focused change beats a
  sweeping refactor.
- Never delete data files, `data/`, or a volume without explicit human approval.
- `npm test` is green before you commit. If you changed the agent-visible
  surface, say so in the commit message.
