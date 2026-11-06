# Working on Twinmind

Twinmind is a Home Assistant add-on: a phone-first (and desktop) chat UI for Claude and Codex.
Server: `twinmind/server` (Node 22, TypeScript, Express + ws). Web: `twinmind/web` (Vite, React,
Tailwind v4, shadcn/ui, AI Elements). Security model: `SECURITY.md`.

## UI rule: use the components, do not build your own

- Always use shadcn/ui (`twinmind/web/src/components/ui`) and AI Elements
  (`twinmind/web/src/components/ai-elements`). Do not hand-roll buttons, cards, dialogs,
  toasts, toggles, spinners, alerts, empty states, code blocks, terminals, etc.
- If a needed component is not in the repo yet, copy it from upstream (shadcn/ui, or
  https://github.com/vercel/ai-elements `packages/elements/src` and `packages/shadcn-ui`),
  rewrite the imports to `@/components/...` / `@/lib/utils`, and add it in its own commit.
- Use components the way their upstream examples do. Keep local changes to copied
  components minimal and list them in `src/components/ai-elements/README.md`.
- Check new dependencies with `npm audit`; pin exact versions.

## Commits

- Author: Gokaku <55299123+Gokaku@users.noreply.github.com>. No "Co-Authored-By" or other AI attribution lines.
- Small, focused commits with a clear message explaining why. Split unrelated changes.
- Every commit must build on its own: run before committing
  `cd twinmind/server && npx tsc -p tsconfig.json --noEmit && npx vitest run` and
  `cd twinmind/web && npx tsc -p tsconfig.json`.
- Commit and push after every step. Until the first good version, push directly to `main`;
  after that, work through pull requests.

## Testing

- Server: `npx vitest run` in `twinmind/server` (fake Home Assistant in `src/testing`).
- UI: run the server with `TWINMIND_DEV_ADMIN_USER=dev TWINMIND_ENABLE_MOCK=1
  TWINMIND_DEV_FAKE_HA=1` (mock assistant + fake HA) and check phone and desktop with
  Playwright screenshots, dark and light.
- Never claim something works in real Home Assistant until it was tested there.
