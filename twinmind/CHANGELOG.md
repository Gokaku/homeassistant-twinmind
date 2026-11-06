# Changelog

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
