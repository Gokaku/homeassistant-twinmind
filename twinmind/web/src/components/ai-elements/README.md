Components in this folder are copied from [AI Elements](https://github.com/vercel/ai-elements)
(commit ca8be600, Apache-2.0, Copyright 2023 Vercel, Inc.), following the shadcn "copy into your
project" model. Changes: import paths, and the math/mermaid/CJK Streamdown plugins removed to keep
the bundle small. `../ui` holds the shadcn/ui components they depend on.

Local changes (marked "Twinmind:" in the code):
- prompt-input.tsx: `accept` also matches file extensions such as `.yaml`.
- speech-input.tsx: idle button style is a ghost button.
- prompt-input.tsx: `submitOnEnter` option on PromptInputTextarea (phones: Enter = new line).
- context.tsx: rows show a cost only when one was computed (no "$0.00" without a model price).
