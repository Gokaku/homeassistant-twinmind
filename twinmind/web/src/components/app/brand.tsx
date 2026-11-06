import { cn } from "@/lib/utils";
import type { ProviderId } from "@/lib/protocol";
import { useId } from "react";
import { BracesIcon, FlaskConicalIcon, SparkleIcon, type LucideIcon } from "lucide-react";

export const PROVIDER_STYLE: Record<ProviderId, { icon: LucideIcon; text: string; bg: string; soft: string; ring: string; name: string }> = {
  claude: { icon: SparkleIcon, text: "text-claude", bg: "bg-claude", soft: "bg-claude-soft", ring: "ring-claude/40", name: "Claude" },
  codex: { icon: BracesIcon, text: "text-codex", bg: "bg-codex", soft: "bg-codex-soft", ring: "ring-codex/40", name: "Codex" },
  mock: { icon: FlaskConicalIcon, text: "text-mock", bg: "bg-mock", soft: "bg-mock/15", ring: "ring-mock/40", name: "Mock" },
};

/** models.dev logo slug per assistant, for the AI Elements ModelSelectorLogo. */
export const PROVIDER_LOGO: Record<ProviderId, string> = { claude: "anthropic", codex: "openai", mock: "vercel" };

export function ProviderAvatar({ provider, className, pulse }: { provider: ProviderId; className?: string; pulse?: boolean }) {
  const s = PROVIDER_STYLE[provider];
  const Icon = s.icon;
  return (
    <span
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-white shadow-sm",
        s.bg,
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={2.5} />
      {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-40", s.bg)} />}
    </span>
  );
}

/** Two overlapping minds. */
export function Logo({ className }: { className?: string }) {
  // Unique ids per instance: with shared ids, every logo would use the gradients of the
  // first one in the document, which may be inside a hidden (display:none) sidebar.
  const id = `tm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}a`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f39a74" />
          <stop offset="1" stopColor="#d9603b" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#86a8ff" />
          <stop offset="1" stopColor="#5b5bf0" />
        </linearGradient>
      </defs>
      <circle cx="25" cy="32" r="16" fill={`url(#${id}a)`} />
      <circle cx="39" cy="32" r="16" fill={`url(#${id}b)`} opacity="0.88" style={{ mixBlendMode: "screen" }} />
    </svg>
  );
}
