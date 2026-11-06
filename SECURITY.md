# Twinmind security model and audit

Last audit: 2026-11-06, add-on version 0.3.1 (previous: 2026-11-05, 0.2.0). Scope: the whole
repository (server, web UI, add-on manifest, Dockerfile, CI). Method: code review, plus
experiments with the real `codex` 0.166 and `claude` 2.1.318 binaries in a sandbox, driven
through Twinmind's own chat service, MCP endpoint and fake Home Assistant with fake model
servers. **Not yet verified on a real
Home Assistant installation** (see "To verify").

## What Twinmind is trusted with

Twinmind runs two AI agents as **root** inside the add-on container, with read/write access
to the Home Assistant configuration folder (`/config`), and gives them Home Assistant tools
backed by the add-on's Supervisor token. Whoever controls an agent's actions can in the worst
case run code in Home Assistant (configuration can run code: `shell_command`,
`custom_components`, `python_script`, ...). The security model therefore rests on:

1. Only Home Assistant **administrators** can use Twinmind.
2. Agents can only do what the chat's **permission mode** allows; anything beyond that needs
   the admin's approval in the UI.
3. Agents never hold credentials that would let them skip step 2.

Main attackers considered: non-admin Home Assistant users, other add-ons on the Supervisor
network, web pages in the user's browser (CSRF), and **prompt injection** (text the agents
read from entity names, logs, files or web pages that tries to make them act).

## Controls

| Area | Control |
| --- | --- |
| Network | No published ports. The app accepts connections only from the Supervisor ingress proxy (172.30.32.2), checked on the TCP peer address, never on forwarded headers. Loopback is *not* trusted (agents run inside the container). `/healthz` is a separate loopback-only route. |
| Admin check | `X-Remote-User-Id` from ingress is looked up via Core WebSocket `config/auth/list`; only active, non-system owners or `system-admin` members pass. Cached 60 s, fails closed. Checked on every HTTP request, the WebSocket upgrade, and every WebSocket message. |
| CSRF | Mutating HTTP requests need the `X-Twinmind: 1` header (no CORS). WebSocket upgrades must be same-origin. |
| XSS | Assistant Markdown is sanitized (rehype-sanitize + harden). Assistant Markdown renders no images at all (a Markdown image would otherwise be a zero-click request to any Home Assistant path, with the admin's cookies). Strict CSP: `script-src 'self' 'wasm-unsafe-eval'` (WASM for the code highlighter), no inline scripts, images only from self/data/blob (provider logos are bundled), `frame-ancestors 'self'`. This matters doubly because ingress serves Twinmind on Home Assistant's own origin. |
| Uploads | Random names, `O_EXCL`, 0600, size cap, type allow-list; non-images are served as downloads, `nosniff`. |
| HA tools | Served over MCP on 127.0.0.1 only, random 256-bit bearer secret, per-conversation token, accepted only while that conversation has a reply running, and decided with the mode of that running reply. Read-only tools run directly; every change goes through Twinmind's gate: run in Bypass/Full access, refuse in Plan/Read only/Don't ask, otherwise ask in the UI. "Always" never covers the raw `ha_websocket`/`ha_rest` tools (one approval per call). Same rules for Claude and Codex. |
| Secrets | `SUPERVISOR_TOKEN`, `HASSIO_TOKEN` and the MCP secret are removed from the environment of every agent process (Codex additionally excludes the MCP secret from the commands it runs, via `shell_environment_policy`); s6's on-disk copy of the token is deleted at start. Claude/Codex logins live in `/data` (0700). |
| Agent config | Claude loads no settings files (no project permissions, hooks or `.mcp.json`); "Always" approvals stay in the session. Codex is refused while a project `.codex/config.toml` exists in `/config` or above. Codex sub-agents (`multi_agent`) and goals are turned off, so nothing keeps running after a reply ends. |
| Add-on permissions | Only `/config` mapped. `homeassistant_api`, and `hassio_api` with role `homeassistant` (core log only). No `manager`, Docker API, host network, full access or privileged capabilities. |
| Supply chain | npm lockfiles committed, exact versions pinned. |

## Findings of this audit

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Critical | Loopback was trusted like the ingress proxy. Any process in the container, including commands run by the agents, could connect to 127.0.0.1 with a forged `X-Remote-User-Id`, act as an admin and approve its own actions. | **Fixed**: only 172.30.32.2 in production; regression test. |
| 2 | High | Agent processes inherited `SUPERVISOR_TOKEN`. Any command an agent ran could call the Home Assistant API directly and bypass the approval gate. | **Fixed**: stripped from agent environments; s6 copy deleted. Residual risk: see A1. |
| 3 | High | Codex starts MCP servers defined in a project `.codex/config.toml` as plain commands, outside its sandbox, even for untrusted projects (verified). An agent allowed to edit `/config` without asking could plant one and get root code execution. | **Fixed**: Codex refuses to start while such a file exists. |
| 4 | High | Claude loaded project/local settings from `/config/.claude/`. In Accept edits mode Claude may write there without asking (allow-all rules, hooks, `.mcp.json`) and escalate to unprompted command execution. | **Fixed**: no settings files are loaded; `/config/CLAUDE.md` is passed as plain text. |
| 5 | High | "Always" approvals forwarded Claude's suggested rules, which can target local/project settings files and persist forever. | **Fixed**: forced to `session`; unit test. |
| 6 | Medium | Pasted Claude sign-in code was written to a pseudo-terminal unfiltered (control characters). | **Fixed**: printable ASCII only. |
| 7 | Medium | Mode descriptions understated the risk of "edit without asking" (config can run code) and of running as root. | **Fixed**: descriptions updated. |

## Findings of the 0.3.1 audit (2026-11-06)

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 8 | High | Codex 0.166 enables sub-agents and goals by default. A goal makes Codex start new turns on its own, in a loop, with the last turn's sandbox (after a Full access turn: unsandboxed root commands with no reply running, invisible and unstoppable in the UI). Sub-agents outlive their turn: one spawned in Full access wrote outside `/config` during a later Read only turn (verified). | **Fixed**: `features.multi_agent=false`, `features.goals=false` on thread start and resume; verified with the real binary that the tools are gone. |
| 9 | Medium | Assistant Markdown could load images from any path on Home Assistant's origin (Streamdown allows every http(s) image, CSP allows `'self'`): a prompt-injected `![](/api/...)` made the admin's browser send a zero-click, cookie-bearing GET to Home Assistant or other ingress add-ons. | **Fixed**: images in assistant Markdown are blocked. |
| 10 | Medium | "Always" on `ha_websocket`/`ha_rest` pre-approved every later raw call in the conversation, contradicting A6. | **Fixed**: one approval per call; unit test. |
| 11 | Low–Medium | Every Codex command could read `TWINMIND_MCP_SECRET` with `env` (verified). | **Fixed**: excluded via `shell_environment_policy`; verified with the real binary. |
| 12 | Low | An HA change request that outlived its reply was decided with that reply's mode (e.g. allowed in Bypass with no reply running). | **Fixed**: the gate only decides for the reply that is still running; tests. |
| 13 | Low (DoS) | `ha_get_logs` treated the filter as a regular expression and ran it in the event loop: `(.*a){20}x` froze the server for >20 s, from a read-only tool allowed in every mode. | **Fixed**: plain case-insensitive text, `\|` separates alternatives; test. |
| 14 | Low | `img-src` allowed https://models.dev: a no-click request carrying data to a third party, and every page load told models.dev about the user. | **Fixed**: the three logos are bundled, models.dev removed from the CSP; test. |

Checked and found sound: the per-turn Codex `sandboxPolicy` (field names match the 0.166 schema; switching Full access → Auto → Read only → Ask on one thread applies each mode, also after resume); the HA gate in every Claude and Codex mode; the Claude SDK `env` option replaces (does not merge) `process.env`; a planted `/config/.claude/settings.json` (allow-all, bypass default, hook) is ignored by the real `claude`; the `answer` message (bounded, answers only reach the tool result); usage events (numbers only); the admin guard on every route, upgrade and message; the ansi-to-react → linkify-it 5 override and Vite shim (the terminal never linkifies; OSC 8 and crafted SGR render as text); Markdown sanitising (`javascript:`/`data:` links, raw HTML, `style`, `on*` stripped; link-safety modal on); uploads, store and handoff ids/paths; `npm audit` clean, exact pins.

## Accepted risks (known, not fixed)

| # | Risk | Why accepted / mitigation |
| --- | --- | --- |
| A1 | Agents run as **root**. A root process can read `/proc/1/environ`, which contains the Supervisor token set by Docker, and the MCP secret from the Codex process. An agent that is allowed to run arbitrary commands can therefore obtain them. | Only matters when commands run without approval (Bypass, Full access, Codex Auto, Claude Auto via classifier) or when the admin approves a malicious command. In those modes the agent can already change `/config` and thus Home Assistant. **Planned**: run the agents as an unprivileged user (see R1). |
| A2 | Elevated modes can change Home Assistant configuration that runs code, without asking. | By design and labelled in the UI. Default modes ask. |
| A3 | Logins (Claude, ChatGPT) and conversations are in `/data` and therefore in Home Assistant backups. | Restoring a backup restores logins, which users expect. Protect backups (HA encrypts cloud backups). Sign out in Twinmind to remove them. |
| A4 | Any Home Assistant admin can see and continue every conversation and approve every pending action. | Admins are equally trusted in Home Assistant itself. |
| A5 | Assistant-written links can point anywhere (clicking one could leak data placed in its URL). | Requires a click and the link-safety dialog; Markdown images are not rendered, other automatic loads are blocked by CSP. |
| A6 | The raw `ha_websocket` / `ha_rest` tools can do anything the Supervisor token can (e.g. create tokens, delete things). | They always need approval outside Bypass/Full access (every call, "Always" does not apply), and the card shows the full request. |
| A7 | The MCP secret and conversation token are on Claude's command line (`--mcp-config`), readable by any process with `ps`. Codex session files in `/data/codex` contain the conversation token. | Same as A1 (needs command execution in the container). Revisit with R1, e.g. an in-process SDK MCP server. |
| A8 | Other Codex project files under `/config/.codex/` (`hooks.json`, `agents/*.toml`) can be written by Claude in Accept edits mode. Codex 0.166 treats project hooks as untrusted (not run) and keeps agent roles in the parent sandbox (verified). | A future Codex version may honour them; see R7. |
| A9 | `ha_check_config` is classed read-only, but Home Assistant's check imports integrations, including `custom_components`. | Planting code needs a write to `/config` first (A2); the check only runs it sooner. |
| A10 | Streamdown passes Markdown `id`/`name` attributes through unprefixed (DOM clobbering). | No exploitable sink found with `script-src 'self'`; upstream choice. |

## To verify on a real Home Assistant

1. The Supervisor ingress proxy **replaces or strips** client-sent `X-Remote-User-*` headers.
   If it passed a forged header through, a logged-in non-admin could impersonate an admin.
   Test: as a non-admin user, open the ingress URL with a forged `X-Remote-User-Id` of an admin;
   Twinmind must answer 403.
2. Ingress connections come from 172.30.32.2 (otherwise Twinmind refuses everything; fails safe).
3. The Supervisor token may call `config/auth/list` (otherwise everyone is refused; fails safe).
4. The WebSocket same-origin check works behind ingress (otherwise the chat cannot connect; fails safe).
5. The s6 environment path is `/run/s6/container_environment` in the current base image.
6. The Supervisor `/core/logs` text format works with the plain-text log filter, and
   `/api/template` and `check_config` stay fast enough not to block a reply.

## Recommendations (next steps)

| # | Recommendation |
| --- | --- |
| R1 | Run Claude and Codex as an unprivileged user with write access only to `/config` and their own home. Removes A1 (no access to root process environments, `/data`, tokens). Needs care with `/config` file ownership. |
| R2 | Pin Docker base images and GitHub Actions by digest/commit SHA, and enable Dependabot. |
| R3 | Add an option to exclude the assistants' logins from backups. |
| R4 | Add an audit log of every approved/denied Home Assistant change (who, when, what). |
| R5 | Add rate limits / a cap on concurrent turns and stored uploads. |
| R6 | Re-run this audit after the first real-installation test, and whenever Claude Code or Codex are updated (both load configuration from disk in ways that change between versions). |
| R7 | Refuse to start Codex while anything exists under `/config/.codex/` (not only `config.toml`), in case later versions honour more project files (A8). |
| R8 | Set `NODE_ENV=production` for the server only (not the agents), so Express never shows stack traces on its default error page. |

## Reporting

Please report security issues privately to the repository owner rather than in public issues.
