// Build shim: ansi-to-react is CommonJS with `exports.default = Ansi` and `__esModule`.
// Vite's bundler (Node-style interop) gives a default import the whole module object,
// which crashes React (error #130). Re-export the real component so the upstream
// AI Elements Terminal can `import Ansi from "ansi-to-react"` unchanged.
import * as mod from "ansi-to-react/lib/index.js";

const m = mod as unknown as { default: unknown };
const Ansi = ((m.default as { default?: unknown })?.default ?? m.default) as typeof import("ansi-to-react").default;
export default Ansi;
