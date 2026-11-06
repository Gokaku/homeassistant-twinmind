# Twinmind for Home Assistant

A Home Assistant add-on to chat with **Claude** and **Codex** about your smart home, from a
phone-first chat UI. Switch between the two in the middle of a conversation; the other one
receives the transcript and carries on.

<p align="center"><img src="twinmind/logo.png" width="250" alt="Twinmind"></p>

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add
   `https://github.com/Gokaku/homeassistant-twinmind`.
2. Install **Twinmind**, start it, and open it from the sidebar.
3. Sign in to Claude and/or Codex from the person icon. See [DOCS.md](twinmind/DOCS.md).

> **Status: early (0.3.x), not yet tested on a real Home Assistant installation.** Expect
> rough edges and please report what breaks.

## Features

- Home Assistant tools for both assistants: entities, logs, history, renames, areas,
  services, automations and scripts, config check, templates.
- Streaming answers, reasoning, and tool cards (commands, file edits, diffs).
- Inline approve / deny / always-allow for every action that needs permission.
- All permission modes of both assistants, clearly labelled by risk.
- Conversation history; native Claude/Codex sessions can be re-opened.
- Attachments and voice dictation.
- Sign in with your own subscriptions (Claude account, ChatGPT account). No API keys needed.
- **Admin-only, enforced server-side** (see below).
- Phone and desktop layouts; dark and light theme; safe areas and on-screen keyboard handled.

## Security model

- The server only accepts connections from the Supervisor ingress proxy (`172.30.32.2`).
  Not even loopback: the assistants run commands inside the container and must not be able
  to reach the app as a user. A separate loopback-only `/healthz` serves the health check.
  No ports are published.
- The `X-Remote-User-Id` set by ingress is looked up in Home Assistant
  (`config/auth/list` over the Core WebSocket API, with the add-on's Supervisor token). Only
  active owners and members of `system-admin` get in. Cached for 60 s; fails closed.
- The check runs on every HTTP request, on the WebSocket upgrade, and again on every
  WebSocket message.
- Mutating HTTP requests need a custom header (CSRF); WebSocket upgrades must be same-origin.
- The assistants reach Home Assistant only through Twinmind's own tool server (MCP on
  127.0.0.1, random bearer secret, per-conversation token, only while a reply is running).
  Changes are approved per the chat's permission mode, enforced by Twinmind.
- Only `/config` is mapped (read/write). No Docker API, no full access, no host network;
  Supervisor API limited to the `homeassistant` role (core log).
- The assistants run as root inside the add-on container. In *Bypass* / *Full access* they can
  run any command there. Use these modes deliberately.

Please report security issues privately (GitHub → Security → Report a vulnerability), not
in public issues.

## Development

```sh
# server (TypeScript, Express + ws)
cd twinmind/server && npm ci && npm test

# web UI (Vite + React + shadcn/ui + AI Elements)
cd twinmind/web && npm ci && npm run build

# run locally with a fake assistant, admin check disabled (loopback only)
cd twinmind/server
TWINMIND_DATA_DIR=../../.dev-data TWINMIND_WORKDIR=../../.dev-data \
TWINMIND_DEV_ADMIN_USER=dev TWINMIND_ENABLE_MOCK=1 TWINMIND_HOST=127.0.0.1 \
npx tsx src/index.ts
# open http://127.0.0.1:8099
```

`npm run dev` in `twinmind/web` starts Vite with a proxy to the server on port 8099.

### Layout

```
repository.yaml          add-on repository manifest
twinmind/
  config.yaml            add-on manifest (ingress, admin panel, /config mapping)
  Dockerfile             web build → server build → HA base image
  run.sh                 entrypoint (sets HOME/CLAUDE_CONFIG_DIR/CODEX_HOME under /data)
  server/src/
    guard.ts             ingress + admin check
    ha.ts                Home Assistant user lookup
    app.ts               HTTP routes and WebSocket
    chat.ts              turn runner, approvals, persistence
    handoff.ts           transcript handoff between assistants
    hass/                Home Assistant client, tools, MCP endpoint, approval policy
    providers/claude.ts  Claude Agent SDK adapter + sign-in
    providers/codex.ts   codex app-server (JSON-RPC) adapter + sign-in
  web/src/
    components/ai-elements/  copied from vercel/ai-elements (Apache-2.0)
    components/ui/           shadcn/ui
    components/app/          Twinmind UI
```

## Credits

UI components from [AI Elements](https://github.com/vercel/ai-elements) and
[shadcn/ui](https://ui.shadcn.com). Claude is a trademark of Anthropic; Codex and ChatGPT are
trademarks of OpenAI. This project is not affiliated with either.

## License

MIT, see [LICENSE](LICENSE). The copied AI Elements components are Apache-2.0 and the
shadcn/ui components MIT; their licenses are next to them.
