# Personal MCP server

*[Русская версия →](README.ru.md)*

A public door where other people's agents read your context and leave you a
message. No authentication, and none coming — a read layer that anyone can read
is the whole point of a door.

This repo is two things at once. It is a **reference**: the same code runs
[postnikov.ai/mcp](https://postnikov.ai/mcp), answering strangers' agents since
August 2026. And it is a **template**: nothing personal lives in the code, all of
it lives in `context/`, which never enters git. Fork it, drop your own files in,
run it — you have a server built to the
[HCP](https://github.com/postnikov/hcp-protocol) shape.

Why you'd want one at all — the idea, the live example and what not to build:
[humancontext.pro](https://humancontext.pro).

## Five minutes

```bash
# 1. Your own copy — "Use this template" on GitHub, or locally:
git clone https://github.com/postnikov/hcp-server.git my-mcp
cd my-mcp && rm -rf .git && git init
npm install

# 2. Your personal layer
cp -r context.example context
$EDITOR context/who.md          # one file is enough to start
$EDITOR context/config.json     # your name, your domain, your caps

# 3. Check it here
npm test
npm start                       # http://localhost:3000/mcp

# 4. Point an agent at it
claude mcp add --transport http me http://localhost:3000/mcp
```

You don't have to write `context/` by hand. The prompt
`prompts/generate-my-hcp.md` in
[`hcp-protocol`](https://github.com/postnikov/hcp-protocol) drafts these files
from material you already published — your CV, your posts, project READMEs, talk
transcripts — and asks you questions only where the material ran out. Details in
`context.example/README.md`.

## Three tiers: read, ask, knock

The default file set plus `ask` gives you seven tools, and add a file and you get
an eighth. The names don't matter much; the split into three tiers does.

| Tier | Cost | What it is |
|---|---|---|
| **file tools** | free · instant · no model in the path | Return a markdown file from your context, unchanged. No LLM, no latency, nothing to inject a prompt into. This tier does most of the work — build it first and you may never need the rest |
| **`ask`** | one API call · hard daily cap | For the question your files don't answer head-on. A model answers strictly from the same files, under a daily ceiling so an experiment can't become a bill. **Off by default**: the only tool that costs money |
| **`leave_message`** | the one write · human in the loop | A note lands in `data/inbox.jsonl` and pushes to your phone. Nothing is published, nothing is auto-answered, and the reply comes from you or not at all |

Access is uniform — every tier is open to every agent, with no key and no
account. What separates the tiers is what each one costs you and how far it
reaches: reading is free and touches nothing, `ask` spends your money against a
budget you set, `leave_message` is the only path that puts something in front of
a human. Everything an agent can reach is something you published on purpose;
the layer you keep private is the one you never put in `context/`.

## The server serves what you have

**Tools are declared by file presence.** No `speaking.md`, no `get_speaking` in
`tools/list` — an agent never gets an empty answer from a tool you don't have.
Drop in `context/reading.md` and `get_reading` appears. No code to touch.

| File in `context/` | Tool |
|---|---|
| `who.md` + `now.md` | `get_profile` |
| `speaking.md` | `get_speaking` |
| `services.md` | `get_services` |
| `channels.md` | `get_channels` |
| `writing.md` | `get_writing` |
| any `X.md` of yours | `get_X` |

The floor is **one file**. `who.md` and nothing else gives you a working server
with two tools (`get_profile`, `leave_message`). Zero files and the server
refuses to start and tells you why: an empty server is worse than no server.

Every call is written to `data/journal.jsonl`. That log is the instrument — it's
how you find out whether anyone's agent actually comes knocking, and what they
came to ask.

## Your personal layer

```
context/                  ← yours, never enters git (.gitignore)
  config.json             name, domain, caps, description overrides
  *.md                    context files; a YAML header names the tool
  deploy.env              VPS address and domain — read only by deploy.sh
context.example/          ← the same thing as a template, committed
.env                      ← secrets, on the server; sample in .env.example
```

A context file may carry a header. It never reaches the agent:

```markdown
---
tool: get_speaking
title: Speaking
for_agent: >
  What is inside and when it's worth calling. The agent reads this BEFORE
  it calls the tool.
---
# Speaking — Your Name
```

No header, and the convention from `config.json → context.groups` applies, then
`get_<filename>`. No description, and an honest one-liner is generated instead
of an invented one.

Everything the server says about you comes out of `context/`: there is not one
personal word in `src/`. A test checks that, so it's a fact and not a promise.

## config.json

The file is optional — without it the server still runs, it just talks about
"the owner of this server". Full annotated version: `context.example/_config.md`.

| Key | What it sets |
|---|---|
| `person` | `name`, `short`, `headline`, `site`, `pronouns` — everything the server says about you that isn't a context file |
| `server` | `id` (the name in the handshake), `connectAs` (the name in `claude mcp add`), `url` (your public `/mcp`), `instructions` (what an agent reads before its first call; empty = assembled from your `person` and the tools that actually exist) |
| `context.groups` | the file → tool map, and the order tools appear in `tools/list`. A file not named here still ships, as `get_<filename>` |
| `tools` | overrides the descriptions of `ask` and `leave_message`. File tools are described by `for_agent` in their own header, next to the content they describe |
| `ask` | `enabled`, `model`, `maxTokens`, and the two daily ceilings |
| `limits` | per-IP buckets: calls per minute, `ask` and `leave_message` per day |
| `discovery` | whether this process serves its own `/llms.txt` and server card |

## Environment

All optional: with no variables at all the server serves files and takes a
message. Commented sample in `.env.example`.

| Variable | What it gives you |
|---|---|
| `ASK_ENABLED` | turns on `ask` (or set it in `config.json`) |
| `ANTHROPIC_API_KEY` | the key for `ask`. **BYOK**: you pay |
| `ASK_MODEL`, `ASK_CALLS_PER_DAY`, `ASK_TOKENS_PER_DAY` | model and daily ceilings |
| `NOTIFY_TG_BOT_TOKEN`, `NOTIFY_TG_CHAT_ID` | Telegram push when a message arrives |
| `NOTIFY_RESEND_API_KEY`, `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM` | the same by email, through Resend's HTTP API |
| `SERVE_DISCOVERY` | serve your own `/llms.txt` and server card (default: yes) |
| `MCP_PUBLIC_URL` | the public address of `/mcp` |
| `PORT`, `DATA_DIR`, `CONTEXT_DIR` | where to listen, where data goes, where your personal layer lives |

Secrets travel by environment only. They are not in the code, not in the config
files, and not in git.

## Limits and money

| What | Default | Where it lives |
|---|---|---|
| All calls | 60/min per IP | process memory |
| `ask` | 10/day per IP | process memory |
| `leave_message` | 5/day per IP | process memory |
| `ask` — calls | 20/day, everyone combined | `data/budget.json`, survives restarts |
| `ask` — tokens | 150,000/day, everyone combined | `data/budget.json`, survives restarts |

The daily `ask` ceilings are money-safety. Per-IP limits are not enough, because
IP addresses are free for an agent and your API key is not. Hit either ceiling
and the tool refuses **without touching the API**, and lists the free file tools
instead. Resets at 00:00 UTC. Numbers live in `context/config.json → ask`.

## Discovery

With `discovery.enabled` the server serves two files itself:

- `/.well-known/mcp/server-card.json` — the MCP registry schema (2025-09-29):
  reverse-DNS name, description under 100 characters,
  `remotes[].type: streamable-http`;
- `/llms.txt` — the same truth for an agent that reads text instead of JSON.

Both are assembled from your config and the **real** tool list, so there is
nothing there to promise a capability you don't have. If your site already
serves those files on the same domain, set `SERVE_DISCOVERY=0`. Two truths are
worse than one.

## Protocol: two eras, one endpoint

Built on **SDK v2** (`@modelcontextprotocol/server` +
`@modelcontextprotocol/node`). `createMcpHandler` serves both protocol eras on
the same `/mcp`, from a single server factory:

- **modern — 2026-07-28**: no `initialize`; version and client ride in a
  per-request envelope (`_meta`), method and tool name are mirrored in the
  `Mcp-Method` / `Mcp-Name` headers (SEP-2243), and `server/discover` returns the
  overview. The response is JSON.
- **legacy — 2025-era**: the ordinary `initialize`, version negotiated from the
  client's request (the SDK's ceiling is 2025-11-25). The response is an **SSE
  frame**, not JSON — that's what the stateless path looks like in SDK v2. It is
  not a change of contract: a 200 only ever went to a client that declared
  `Accept: text/event-stream`.

Use a current SDK when you fork this. Modern clients do not negotiate their way
down to legacy-era servers on their own, and an old server is a door today's
agents can't open.

## Deploy to your own VPS

```bash
cp context.example/deploy.env context/deploy.env   # server, domain, names
$EDITOR context/deploy.env
./deploy.sh
```

`deploy.sh` runs the tests, previews what would be deleted on production (a gate
in front of `--delete`), mirrors the working tree, loads `context/deploy.env`
into the environment and rebuilds the container, then smoke-tests
`MCP_PUBLIC_URL`. `.env` and `data/` never cross the border: secrets and the
journal live on production only.

`docker-compose.yml` assumes traefik — domain, router priority and certresolver
all come from `deploy.env`. The router priority must be **higher** than that of
the site on the same domain, or requests to `/mcp` go to the site and the agent
gets an HTML 404 instead of JSON-RPC.

No traefik? Drop the `labels` block, publish the port and put anything that
speaks TLS in front.

## Check a running server

```bash
# the tool list
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'

# a file tool
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}' \
  | jq -r '.result.content[0].text'
```

A hand-written curl in the modern era, with no `Mcp-Method` / `Mcp-Name`, gets
`-32020` back. That is the correct answer, not a breakage. The real check is an
official MCP client.

## Rules worth keeping

- **Public facts only.** Everything in `context/` goes to any agent, with no
  authorization. Nothing about family, health, finances or deal sizes.
- **No prices at all** — "pricing on request, use `leave_message`". Otherwise
  your rate card ends up in someone else's cache and outlives every correction
  you make.
- **Context is read at process start.** Edit a file, restart the server.
- **No tool executes the content of its arguments**: the question in `ask` is
  sent declared as data, and a `leave_message` goes to a file and to a
  notification with no markup. Don't break that.
- **Read every version with your own eyes before it ships.** An agent that
  assembles your pack from your notes will happily carry something private
  across.

## Layout

```
context.example/  template for the personal layer (context/ is yours, not in git)
src/config.js     config: defaults, context/config.json, env
src/context.js    your files → sections and the tool list
src/mcp.js        the protocol: tools, schemas, journal, mounting /mcp
src/lib.js        state on disk, budget cap, validation, Anthropic + notifications
src/discovery.js  server-card.json and llms.txt from the config
src/server.js     express, client IP behind a proxy, rate-limit buckets, startup
test.js           node:test on fixtures, everything outbound mocked
data/             journal.jsonl, inbox.jsonl, budget.json (not in git)
```

Two dependencies: `express` and the MCP SDK. No ORM, no database, no SMTP
client — mail goes out over plain `fetch`. Keep it that way.

## License

[MIT](LICENSE) — take it, change it, run it, sell services on top of it.
Attribution belongs in the code (the copyright line in `LICENSE`), not on your
site. What's in your `context/` is yours either way: the code never touches it.
