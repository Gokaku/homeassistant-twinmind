import type { ProviderId } from "@/lib/protocol";

/** models.dev logo slug per assistant, for the AI Elements ModelSelectorLogo. */
export const PROVIDER_LOGO: Record<ProviderId, string> = { claude: "anthropic", codex: "openai", mock: "vercel" };

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", mock: "Mock" };

/** The app icon (public/favicon.svg). */
export const APP_ICON = "./favicon.svg";
