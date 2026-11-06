import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { ProviderInfo } from "@/lib/protocol";
import { refreshProviders, toast, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ExternalLinkIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { PROVIDER_LOGO } from "./brand";
import { confirmDialog } from "./dialogs";

export function AccountsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const providers = useStore((s) => s.providers);
  const user = useStore((s) => s.user);
  useEffect(() => {
    if (open) void refreshProviders();
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[92vw] max-w-md gap-0 p-0 pt-safe">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-base">Accounts</SheetTitle>
          <SheetDescription className="text-xs">Sign in with your own subscriptions. Tokens stay inside this add-on.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 pb-safe">
          {providers
            .filter((p) => p.id !== "mock")
            .map((p) => (
              <ProviderCard key={p.id} p={p} />
            ))}
          <Alert>
            <ShieldCheckIcon />
            <AlertDescription className="text-xs">
              <p>
                Signed in to Home Assistant as <b className="text-foreground">{user?.name ?? "…"}</b>. Twinmind only opens for Home
                Assistant administrators; both assistants can read and change files in <code>/config</code>.
              </p>
            </AlertDescription>
          </Alert>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ProviderCard({ p }: { p: ProviderInfo }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const a = p.auth;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
      void refreshProviders();
    }
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex items-center gap-3 py-4">
        <Item variant="default" size="sm" className="flex-1 border-0 p-0">
          <ItemMedia variant="icon">
            <ModelSelectorLogo provider={PROVIDER_LOGO[p.id]} className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>{p.label}</ItemTitle>
            <ItemDescription className="truncate">
              {a.state === "signed-in"
                ? [a.account, a.plan].filter(Boolean).join(" · ") || "Signed in"
                : a.state === "pending"
                  ? "Waiting for sign-in…"
                  : a.state === "unavailable"
                    ? a.reason
                    : "Not signed in"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {a.state === "signed-in" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={async () =>
                  (await confirmDialog({ title: `Sign out of ${p.label}?`, confirmLabel: "Sign out", destructive: true })) &&
                  run(() => api(`providers/${p.id}/logout`, { method: "POST" }))
                }
              >
                <LogOutIcon /> Sign out
              </Button>
            ) : a.state === "pending" ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`providers/${p.id}/login/cancel`, { method: "POST" }))}>
                Cancel
              </Button>
            ) : a.state === "signed-out" ? (
              <Button size="sm" disabled={busy} onClick={() => run(() => api(`providers/${p.id}/login`, { method: "POST" }))}>
                {busy && <Spinner />} Sign in
              </Button>
            ) : null}
          </ItemActions>
        </Item>
      </CardHeader>

      {a.state === "pending" && a.flow === "code-paste" && (
        <CardContent className="space-y-3 border-t py-4">
          <Step n={1}>Open the sign-in page and approve access.</Step>
          <Button asChild variant="outline" className="w-full">
            <a href={a.url} target="_blank" rel="noreferrer">
              Open claude.com <ExternalLinkIcon />
            </a>
          </Button>
          <Step n={2}>Paste the code it shows you.</Step>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) void run(() => api(`providers/${p.id}/login/code`, { json: { code: code.trim() } }).then(() => setCode("")));
            }}
          >
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Authentication code" autoComplete="off" />
            <Button type="submit" disabled={busy || !code.trim()}>
              {busy ? <Spinner /> : "Finish"}
            </Button>
          </form>
        </CardContent>
      )}

      {a.state === "pending" && a.flow === "device-code" && (
        <CardContent className="space-y-3 border-t py-4">
          <Step n={1}>Open the ChatGPT device page and sign in.</Step>
          <Button asChild variant="outline" className="w-full">
            <a href={a.url} target="_blank" rel="noreferrer">
              Open {hostOf(a.url)} <ExternalLinkIcon />
            </a>
          </Button>
          <Step n={2}>Enter this code:</Step>
          <Snippet code={a.code} className="h-12">
            <SnippetInput aria-label="Device code" className="text-center font-semibold text-xl tracking-[0.2em]" />
            <SnippetCopyButton />
          </Snippet>
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" /> This updates by itself once you are done.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "sign-in page";
  }
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <span className="flex size-5 items-center justify-center rounded-full bg-foreground font-semibold text-[11px] text-background">{n}</span>
      {children}
    </p>
  );
}
