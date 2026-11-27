# Twinmind

Chat with **Claude** and **Codex** about your Home Assistant setup, from any phone or browser.
Both assistants work directly in your configuration folder (`/config`): they can read your YAML,
explain errors, and write automations. You can switch between them in the middle of a
conversation, for example let Claude draft an automation and Codex review it.

## Who can use it

Twinmind is **only for Home Assistant administrators**. This is checked by the add-on itself on
every request and every WebSocket message, not just by hiding the sidebar entry:

1. Only the Home Assistant ingress proxy may connect. Other add-ons on the same Docker network
   are refused, and no port is published.
2. The Home Assistant user behind the request must be the owner or in the *Administrators* group.
   Twinmind asks Home Assistant (cached for one minute). If Home Assistant cannot be reached,
   nobody gets in.

## What it can do in Home Assistant

Besides reading and editing files in `/config`, both assistants get Home Assistant tools:

| Read (never asks) | Change (asks first, see below) |
| --- | --- |
| Overview: version, integrations, areas, entity counts | Call any service / action |
| Search entities by name, area, device, domain | Rename an entity, change its entity_id, icon, area; hide or disable it |
| Entity details and attributes | Rename a device or move it to an area |
| Logs: collected errors, raw core log, with filters | Create areas |
| History and logbook | Create, edit and delete automations and scripts (same API as the UI editor) |
| Render templates, check configuration | Raw WebSocket / REST calls for anything else |
| Services, stored automation and script configs | |

Try: *"What errors are in my logs today?"*, *"Rename my Hue lights after their rooms"*,
*"Turn off the hallway light at sunset unless someone is home"*.

## Signing in

Open Twinmind, tap the person icon (top right) and sign in:

- **Claude**: tap *Sign in*, open the claude.com link, approve, copy the code it shows and paste
  it back into Twinmind. Uses your Claude Pro/Max subscription.
- **Codex**: tap *Sign in*, open the link, sign in with ChatGPT and enter the code shown in
  Twinmind. The page updates by itself. Uses your ChatGPT plan.

Logins are stored in the add-on's private data folder (`/data`) and are included in add-on
backups. Signing out from Twinmind removes them.

## Permission modes

Tap the button next to the microphone (it shows model, thinking level and mode) and pick a
mode under *Permission mode*; the mode's description is shown below it.

| Claude | What it does |
| --- | --- |
| Ask | Asks before edits and commands (default) |
| Plan | Explores read-only and proposes a plan; you approve the plan |
| Accept edits | Edits files without asking, still asks for commands |
| Auto | A safety classifier approves or blocks each action; HA changes run without asking |
| Don't ask | Never asks; anything not pre-approved is denied |
| Bypass | Runs everything without asking |

| Codex | What it does |
| --- | --- |
| Read only | Reads files; asks before any change |
| Ask | Asks before anything that is not a known-safe read (default) |
| Auto | Works in `/config` and makes Home Assistant changes on its own; asks to go beyond the sandbox and for raw HA API calls |
| Full access | No sandbox, no questions |

**Bypass** and **Full access** let the assistant run any command inside the add-on container
with read/write access to `/config`. Make a backup first.

When an approval card appears you can *Deny*, *Allow* once, or allow *Always* for the rest of
that conversation.

Changes to Home Assistant itself (renames, services, automations) follow the same idea:
they run without asking in **Bypass** / **Full access** and in **Auto**, are refused in
**Plan**, **Read only** and **Don't ask**, and show an approval card in every other mode.
Twinmind enforces this itself, for Claude and Codex alike. Reading never asks.

Raw WebSocket/REST commands are judged by what they do: reads (`config_entries/get`,
`lovelace/config`, `…/list`, REST `GET`, ...) never ask, ordinary changes follow the mode like
the other tools (*Always* applies to that one command), and sensitive commands (users,
tokens, sign-in, Supervisor, backups, cloud, OAuth credentials) ask every time unless the
mode is Full access / Bypass.

## Models and thinking

One button next to the microphone shows the model, the thinking level and the mode
(e.g. "6.1-Sol · XHigh · Auto"). Tapping it opens everything in one place:

- **Model**: the exact models of both assistants, as Claude Code and Codex list them. The one
  each assistant recommends is marked and preselected until you pick another; Twinmind always
  sends the exact model with every message. Picking a model of the other assistant switches
  assistants (the conversation is handed over).
- **Thinking**: *Low*, *Medium*, *High*, *Extra high*, *Max*, ... whatever the model supports.
  It starts at the model's default (*High* for Claude) and is remembered on this device.
- **Permission mode**: see above.

## Questions, plans and context

- When an assistant needs a decision, it asks in the chat with options to tap (or your own
  answer). *Skip* dismisses the question.
- In **Plan** mode Claude explores first and then shows its plan in a card; *Allow* lets it
  start working, *Deny* keeps it planning.
- The ring next to the mode picker shows how full the assistant's context window is.

## Tips

- Attach photos, YAML files or log excerpts with the paperclip.
- The microphone uses your browser's speech recognition (Chrome, Edge, Safari). It is not
  available in every browser or in every Home Assistant app web view.
- *Continue a session* in the menu lists Claude and Codex sessions stored by this add-on that are
  not in your Twinmind history (for example after you deleted a chat), so you can pick them up
  again. Sessions from other add-ons live in their own containers and are not visible.

## Options

| Option | Description |
| --- | --- |
| `debug` | Write the raw output of the Claude and Codex processes to the add-on log. |

## Known limitations

- Codex's sandbox uses bubblewrap. Inside the add-on container it may not be able to create its
  sandbox; if Codex commands fail with a sandbox error, use *Full access* (with care).
- Voice input falls back to nothing in browsers without the Web Speech API.
- Supervisor, host and add-on logs are not available: that would need the Supervisor
  `manager` role, which Twinmind does not request.
