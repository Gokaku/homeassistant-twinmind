import type { ProviderId } from "@/lib/protocol";

/** Logo per assistant (public/logos/<slug>.svg, copied from models.dev), for the AI Elements ModelSelectorLogo. */
export const PROVIDER_LOGO: Record<ProviderId, string> = { claude: "anthropic", codex: "openai", mock: "vercel" };

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", mock: "Mock" };

/** The app icon (public/favicon.svg). */
export const APP_ICON = "./favicon.svg";
