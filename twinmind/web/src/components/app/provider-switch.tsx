import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ProviderId } from "@/lib/protocol";
import { setProvider, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PROVIDER_STYLE } from "./brand";

/** Who answers the next message. Switching mid-chat hands over the transcript. */
export function ProviderSwitch({ className }: { className?: string }) {
  const providers = useStore((s) => s.providers);
  const current = useStore((s) => s.provider);
  if (!providers.length) return null;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={current}
      // A single toggle group allows deselecting; keep one provider selected.
      onValueChange={(v) => v && setProvider(v as ProviderId)}
      aria-label="Assistant"
      className={cn("shrink-0 bg-background", className)}
    >
      {providers.map((p) => {
        const s = PROVIDER_STYLE[p.id];
        const Icon = s.icon;
        const needsLogin = p.auth.state !== "signed-in";
        return (
          <ToggleGroupItem key={p.id} value={p.id} aria-label={p.label} className="gap-1.5 px-2.5 sm:px-3">
            <Icon className={cn(p.id === current && s.text)} strokeWidth={2.5} />
            <span>{p.label}</span>
            {needsLogin && <span className="size-1.5 rounded-full bg-warn" aria-label="not signed in" />}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
