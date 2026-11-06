import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { ProviderInfo } from "@/lib/protocol";
import { refreshProviders, toast, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon, ExternalLinkIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { PROVIDER_STYLE } from "./brand";
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
          <div className="flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-muted-foreground text-xs">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-safe" />
            <p>
              Signed in to Home Assistant as <b className="text-foreground">{user?.name ?? "…"}</b>. Twinmind only opens for Home Assistant
              administrators; both assistants can read and change files in <code>/config</code>.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ProviderCard({ p }: { p: ProviderInfo }) {
  const s = PROVIDER_STYLE[p.id];
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
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
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center gap-3 p-4">
        <span className={cn("flex size-10 items-center justify-center rounded-xl", s.soft)}>
          <s.icon className={cn("size-5", s.text)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{p.label}</div>
          <div className="truncate text-muted-foreground text-xs">
            {a.state === "signed-in"
              ? [a.account, a.plan].filter(Boolean).join(" · ") || "Signed in"
              : a.state === "pending"
                ? "Waiting for sign-in…"
                : a.state === "unavailable"
                  ? a.reason
                  : "Not signed in"}
          </div>
        </div>
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
            <LogOutIcon className="size-4" /> Sign out
          </Button>
        ) : a.state === "pending" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`providers/${p.id}/login/cancel`, { method: "POST" }))}>
            Cancel
          </Button>
        ) : a.state === "signed-out" ? (
          <Button size="sm" disabled={busy} className={cn("rounded-full text-white", s.bg)} onClick={() => run(() => api(`providers/${p.id}/login`, { method: "POST" }))}>
            {busy ? <Spinner className="size-4" /> : null} Sign in
          </Button>
        ) : null}
      </div>

      {a.state === "pending" && a.flow === "code-paste" && (
        <div className="space-y-3 border-t bg-muted/30 p-4">
          <Step n={1}>Open the sign-in page and approve access.</Step>
          <Button asChild variant="outline" className="w-full rounded-xl">
            <a href={a.url} target="_blank" rel="noreferrer">
              Open claude.com <ExternalLinkIcon className="size-4" />
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
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Authentication code" autoComplete="off" className="rounded-xl" />
            <Button type="submit" disabled={busy || !code.trim()} className="rounded-xl">
              {busy ? <Spinner className="size-4" /> : "Finish"}
            </Button>
          </form>
        </div>
      )}

      {a.state === "pending" && a.flow === "device-code" && (
        <div className="space-y-3 border-t bg-muted/30 p-4">
          <Step n={1}>Open the ChatGPT device page and sign in.</Step>
          <Button asChild variant="outline" className="w-full rounded-xl">
            <a href={a.url} target="_blank" rel="noreferrer">
              Open {hostOf(a.url)} <ExternalLinkIcon className="size-4" />
            </a>
          </Button>
          <Step n={2}>Enter this code:</Step>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-3 rounded-xl border bg-background py-3 font-mono font-semibold text-2xl tracking-[0.2em]"
            onClick={() => {
              void navigator.clipboard?.writeText(a.code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
            }}
          >
            {a.code}
            {copied ? <CheckIcon className="size-4 text-safe" /> : <CopyIcon className="size-4 text-muted-foreground" />}
          </button>
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" /> This updates by itself once you are done.
          </p>
        </div>
      )}
    </div>
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
