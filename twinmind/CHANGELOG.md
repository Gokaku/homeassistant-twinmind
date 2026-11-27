# Changelog

## 0.5.0

- Write while the assistant is working, as in the Claude and Codex apps:
  - A message sent during a reply goes straight into it: the assistant sees it at its next
    step (Codex: `turn/steer`; Claude: Claude Code's input stream). Its answer continues
    below your message.
  - If it cannot go in (another assistant or mode was picked, or the reply was just ending),
    it waits as "Sends when the reply is done" and is sent automatically; several waiting
    messages go out together. The ✕ next to it takes it back.
  - Stop also drops the waiting messages and puts their text back in the composer.
  - While a reply runs, the send button stops it when the box is empty and sends when you
    have typed something.

## 0.4.1

- Raw Home Assistant commands (the WebSocket/REST escape hatches) are judged by what they do
  instead of always asking:
  - **Reads** (`config_entries/get`, `lovelace/config`, `…/list`, `…/get`, REST `GET`, ...)
    run without asking, in every mode.
  - **Ordinary changes** (delete an integration, create an area, ...) are treated like the
    other HA tools: no question in Auto, and *Always* applies to that one command.
  - **Sensitive** commands (users, tokens, sign-in, Supervisor, backups, cloud, OAuth
    credentials) ask every time unless the mode never asks (Full access / Bypass).

## 0.4.0

- Model, thinking level and permission mode are in one button in the composer, which opens
  them all in one dialog: more room on phones. The button never cuts text off: when space is
  short it leaves out whole parts (first the "GPT-" prefix, then the thinking level, then the
  mode) instead. The dialog fits phones in portrait and landscape.
- Thinking level (Low, Medium, High, Extra high, Max, ... as the model supports) can be
  picked for Claude and Codex.
- The vague "Default" model is gone. Claude's models now come from Claude Code itself (the
  fixed Opus/Sonnet/Haiku list was missing newer models such as Fable); the one each
  assistant recommends is marked and preselected. Model and thinking level are sent with
  every message (before, Codex's "Default" kept whatever model an earlier message had used).
- Codex: no more double approvals for Home Assistant changes. Codex asked again for every
  HA tool call on top of Twinmind's own decision by mode.
- **Auto** (Claude and Codex) makes Home Assistant changes without asking; only raw
  WebSocket/REST calls still ask.
- Security: Claude now gets the Home Assistant tool server's secret over stdin instead of the
  command line, where any command Claude ran could read it from `/proc`.
- Updated Claude Agent SDK to 0.3.332 and Codex to 0.172.0. Codex's new sub-agent runtime
  (`multi_agent_v2`) is switched off like the old one.

## 0.3.9

- The model button shows the selected model (e.g. Default, Opus, Sonnet) next to the logo.

## 0.3.8

- The composer tools fit on phones: the model button shows just "Claude"/"Codex" or the picked
  model (only the logo on very narrow screens) instead of cut-off text.

## 0.3.7

- More space between the mode picker and the send button, and above the composer.

## 0.3.6

- The composer no longer jumps to two lines when you pick a long mode such as "Accept edits".
- Landscape on phones: the welcome text no longer overlaps the composer.
- The prompt suggestions line up with the composer on desktop.

## 0.3.5

- Copy buttons work when Home Assistant is opened over http:// and in the companion app.

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
