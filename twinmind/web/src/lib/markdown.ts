import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

type PluggableList = NonNullable<StreamdownProps["rehypePlugins"]>;
type Plugin = Extract<PluggableList[number], (...args: never[]) => unknown>;

// Streamdown's defaults (raw HTML -> rehype-sanitize -> rehype-harden), but harden no
// longer allows images from every http(s) URL. Assistant text can be steered by prompt
// injection, and ingress serves Twinmind on Home Assistant's own origin: a Markdown image
// such as ![](/api/...) would make the admin's browser send a zero-click GET to any Home
// Assistant path (with its session cookies), and the CSP cannot tell those apart from the
// app's own requests. Images now render as "[Image blocked: alt]" (rehype-sanitize already
// drops data:/blob: sources). Links are unchanged (they need a click + the link-safety modal).
const [harden, hardenOptions] = defaultRehypePlugins.harden as [Plugin, Record<string, unknown>];

export const markdownRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [harden, { ...hardenOptions, allowedImagePrefixes: [] }],
];
