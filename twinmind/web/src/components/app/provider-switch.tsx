import { cn } from "@/lib/utils";
import { setProvider, useStore } from "@/lib/store";
import { motion } from "motion/react";
import { PROVIDER_STYLE } from "./brand";

/** Segmented control to pick who answers the next message. Switching mid-chat hands over the transcript. */
export function ProviderSwitch({ className }: { className?: string }) {
  const providers = useStore((s) => s.providers);
  const current = useStore((s) => s.provider);
  if (!providers.length) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Assistant"
      className={cn("relative flex shrink-0 rounded-full bg-muted p-0.5 ring-1 ring-border", className)}
    >
      {providers.map((p) => {
        const s = PROVIDER_STYLE[p.id];
        const Icon = s.icon;
        const active = p.id === current;
        const needsLogin = p.auth.state !== "signed-in";
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setProvider(p.id)}
            className={cn(
              "relative z-0 flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium text-[13px] transition-colors sm:px-3 sm:text-sm",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="provider-pill"
                className="-z-10 absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-border"
                transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
              />
            )}
            <Icon className={cn("size-3.5", active && s.text)} strokeWidth={2.5} />
            <span>{p.label}</span>
            {needsLogin && <span className="size-1.5 rounded-full bg-warn" aria-label="not signed in" />}
          </button>
        );
      })}
    </div>
  );
}
