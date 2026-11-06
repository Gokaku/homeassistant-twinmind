import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Promise-based confirm/prompt dialogs. window.confirm/prompt are unreliable
 * inside the Home Assistant companion apps' web views.
 */
interface Ask {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  input?: { value: string; placeholder?: string };
  resolve: (v: string | boolean | null) => void;
}

let current: Ask | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function confirmDialog(opts: Omit<Ask, "resolve" | "input">): Promise<boolean> {
  return new Promise((resolve) => {
    current = { ...opts, resolve: (v) => resolve(v === true) };
    emit();
  });
}

export function promptDialog(opts: Omit<Ask, "resolve" | "input"> & { value: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    current = { ...opts, input: { value: opts.value, placeholder: opts.placeholder }, resolve: (v) => resolve(typeof v === "string" ? v : null) };
    emit();
  });
}

export function DialogHost() {
  const ask = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current,
  );
  const [value, setValue] = useState("");
  useEffect(() => setValue(ask?.input?.value ?? ""), [ask]);
  const close = (v: string | boolean | null) => {
    ask?.resolve(v);
    current = null;
    emit();
  };
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ask?.title}</DialogTitle>
          {ask?.description && <DialogDescription>{ask.description}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            close(ask?.input ? value.trim() || null : true);
          }}
          className="space-y-4"
        >
          {ask?.input && (
            <Input autoFocus value={value} placeholder={ask.input.placeholder} onChange={(e) => setValue(e.target.value)} className="rounded-xl" />
          )}
          <DialogFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit" variant={ask?.destructive ? "destructive" : "default"}>
              {ask?.confirmLabel ?? "OK"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
