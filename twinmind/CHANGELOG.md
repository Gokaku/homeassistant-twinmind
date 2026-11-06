# Changelog

## 0.3.4

- Cleaner add-on log: no repeated Claude SDK warning on every reply, no bashio deprecation
  warning at start.

## 0.3.3

- Claude's thinking is shown again (the Thinking block was empty).

## 0.3.2

Security audit of 0.3.1 and a UI check.

- Security: Codex sub-agents and goals are turned off; they kept running after a reply
  ended, with the sandbox of the earlier turn.
- Security: assistant answers no longer show images (they could make the browser call any
  Home Assistant address without a click). Provider logos are bundled; the app no longer
  contacts models.dev.
- Security: "Always" no longer pre-approves raw Home Assistant WebSocket/REST calls; commands
  run by Codex no longer see the MCP secret; an HA change is never decided with the mode of
  a reply that already ended.
- Stability: the Home Assistant log filter is plain text (a crafted pattern could freeze the
  server).
- UI: header fits below the iPhone notch, tool cards fit on narrow phones, attachments
  show their name and can be removed on touch screens, icon buttons have labels, focus
  returns after closing the Accounts sheet, "Thought for 1 second".

## 0.3.1

- The UI is built only from shadcn/ui and AI Elements components, following the AI Elements
  chatbot: the assistant and model are picked in one ModelSelector (with provider logos)
  instead of a header switch, attachments are added from the prompt's action menu, tool
  calls use the standard Tool header/input/output, approvals the standard Confirmation, the
  conversation list is the shadcn Sidebar, and the welcome, error and admin-only screens use
  the empty-state components. Custom colors, avatars and layouts were removed.

## 0.3.0

- Assistants can ask you questions (single or multiple choice, or free text) and continue
  with your answers. Claude's question tool is enabled again.
- Plans from Claude's plan mode are shown in a plan card that you approve or deny.
- Todo lists are shown as a task queue with progress.
- A context meter shows how full the model's context window is.
- The UI now uses shadcn/ui and AI Elements components throughout (toasts, confirmation
  dialogs, assistant switch, cards, empty states, tooltips, terminal output).

## 0.2.1

Fixes from a full code review.

- Security: Codex now applies the selected sandbox on every turn (a chat that once ran in
  Full access stayed unsandboxed after switching to a stricter mode).
- Stability: several ways to crash the server are gone (messages over 1 MB, Codex
  app-server crashes or failed starts, a missing upload file); added a Supervisor watchdog.
- Sending: messages are no longer lost when the server rejects them or the connection
  drops, the composer cannot get stuck, the mic button no longer sends the message.
- Opening a chat while it streams no longer loses text or leaves it stuck "running".
- Attachments: YAML, JSON, PDF and log files work.
- Home Assistant tools: history/logbook return the requested window, saving automations or
  scripts never overwrites another one, an approval is cancelled if the tool call gave up.
- Codex: finished commands no longer flip back to running, a chat whose first turn failed
  recovers, multiple approvals per command each get a card.
- UI: logo visible on phones, Enter adds a new line on phones, command output in a terminal
  view with colors and copy, copy button on answers, error page instead of a blank screen,
  expired Home Assistant sessions reconnect instead of showing "admin-only".

## 0.2.0

- Home Assistant tools for both assistants: search entities, read logs and history,
  rename entities and devices, manage areas, call services, create and edit automations
  and scripts through the config API, check configuration, render templates, plus raw
  WebSocket/REST calls for everything else.
- Changes to Home Assistant go through Twinmind's approval card (or run directly in
  Bypass / Full access, or are refused in read-only modes).
- Desktop layout with a permanent conversation sidebar.
- The add-on now uses the Supervisor API with the `homeassistant` role, to read the raw
  Home Assistant log.

## 0.1.0

First version. Not yet tested on a real Home Assistant installation.

- Chat with Claude (Agent SDK) and Codex (app-server) from one phone-first UI.
- Switch assistant mid-conversation; the other one receives the transcript.
- Streaming answers, reasoning, tool cards with inline approve/deny.
- Every permission mode of both assistants, with risk labels.
- Conversation history; native sessions can be re-opened.
- Attachments (photos, YAML, logs) and browser voice dictation.
- Sign in with your Claude and ChatGPT subscriptions from the UI.
- Admin-only, enforced by the server.
