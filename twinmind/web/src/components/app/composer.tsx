import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { ModeInfo } from "@/lib/protocol";
import { currentMode, interrupt, sendMessage, setMode, setModel, toast, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LogInIcon, PaperclipIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { PROVIDER_STYLE } from "./brand";

const RISK_DOT: Record<ModeInfo["risk"], string> = {
  safe: "bg-safe",
  normal: "bg-codex",
  elevated: "bg-warn",
  danger: "bg-danger",
};

// Browser speech recognition (Chrome, Edge, Safari). Without it the mic could only record
// audio for a transcription service we do not have, so it is hidden instead of greyed out.
const canDictate = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

const isTouch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function Composer({ onOpenAccounts, suggestion }: { onOpenAccounts: () => void; suggestion: { text: string; n: number } | null }) {
  const providerId = useStore((s) => s.provider);
  const info = useStore((s) => s.providers.find((p) => p.id === s.provider));
  const mode = useStore((s) => currentMode(s));
  const model = useStore((s) => s.models[s.provider] ?? "");
  const pending = useStore((s) => !!s.pending);
  const currentId = useStore((s) => s.currentId);
  const running = useStore((s) => {
    const c = s.currentId ? s.details[s.currentId] : null;
    return !!c?.messages.some((m) => m.status === "streaming");
  });
  const connected = useStore((s) => s.connection === "open");
  // Context usage of the latest reply that reported it, in the open chat.
  const usage = useStore((s) => {
    const c = s.currentId ? s.details[s.currentId] : null;
    if (!c) return undefined;
    for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].usage) return c.messages[i].usage;
    return undefined;
  });
  const controller = usePromptInputController();
  const runningRef = useRef(running);
  runningRef.current = running;
  const style = PROVIDER_STYLE[providerId];
  const modeInfo = info?.modes.find((m) => m.id === mode);

  useEffect(() => {
    if (suggestion) controller.textInput.setInput(suggestion.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion?.n]);

  const onSubmit = useCallback(
    async (msg: PromptInputMessage) => {
      if (!msg.text.trim() && msg.files.length === 0) return;
      if (runningRef.current) {
        toast("Wait for the reply to finish, or stop it first.", "info");
        throw new Error("busy"); // keeps the text in the box
      }
      const ok = await sendMessage(msg.text, msg.files.map((f) => ({ url: f.url, mediaType: f.mediaType, filename: f.filename })));
      if (!ok) throw new Error("not sent"); // keeps the text in the box
    },
    [],
  );

  if (info && info.auth.state !== "signed-in") {
    return (
      <div className="mx-auto w-full max-w-3xl px-3 pb-safe">
        <Item variant="outline" className="bg-card shadow-sm">
          <ItemMedia variant="icon" className={cn("border-0", style.soft)}>
            <style.icon className={style.text} />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Sign in to {info.label}</ItemTitle>
            <ItemDescription className="truncate">
              {info.auth.state === "pending"
                ? "Sign-in in progress"
                : info.auth.state === "unavailable"
                  ? info.auth.reason
                  : `Use your ${info.id === "claude" ? "Claude" : "ChatGPT"} subscription`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" onClick={onOpenAccounts}>
              <LogInIcon /> Sign in
            </Button>
          </ItemActions>
        </Item>
      </div>
    );
  }

  const status = pending ? "submitted" : running ? "streaming" : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-safe">
      {modeInfo?.risk === "danger" && (
        <Alert variant="destructive" className="mb-2 py-2">
          <ShieldAlertIcon />
          <AlertDescription className="text-xs">
            <p>
              <b>{modeInfo.label}</b>: {modeInfo.description}
            </p>
          </AlertDescription>
        </Alert>
      )}
      <PromptInput
        onSubmit={onSubmit}
        multiple
        maxFiles={10}
        maxFileSize={20 * 1024 * 1024}
        accept="image/*,text/*,.yaml,.yml,.json,.log,.txt,.md,.pdf,.csv,.xml"
        onError={(e) => toast(e.message)}
        className={cn(
          "rounded-3xl bg-card shadow-lg shadow-black/5 transition-shadow [&_[data-slot=input-group]]:rounded-3xl",
          modeInfo?.risk === "danger" && "[&_[data-slot=input-group]]:border-danger/60",
        )}
      >
        <ComposerAttachments />
        <PromptInputBody>
          <PromptInputTextarea
            placeholder={`Message ${style.name}…`}
            // On phones Enter adds a new line and the send button sends.
            submitOnEnter={!isTouch()}
            enterKeyHint={isTouch() ? "enter" : "send"}
            className="min-h-12 px-4 pt-3.5"
          />
        </PromptInputBody>
        <PromptInputFooter className="gap-1 px-2 pb-2">
          <PromptInputTools className="min-w-0 gap-0.5">
            <AttachButton />
            {canDictate && (
            <SpeechInput
              // It sits inside the form: without type="button" it would submit the message.
              type="button"
              aria-label="Dictate"
              lang={navigator.language || "en-US"}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
              onTranscriptionChange={(t) => {
                const cur = controller.textInput.value;
                controller.textInput.setInput(cur ? `${cur.replace(/\s+$/, "")} ${t}` : t);
              }}
            />
            )}
            {info && (
              <PromptInputSelect value={mode} onValueChange={(v) => setMode(providerId, v)}>
                <PromptInputSelectTrigger className="h-8 min-w-0 gap-1.5 rounded-full px-2.5 text-xs" aria-label="Permission mode">
                  <span className={cn("size-2 shrink-0 rounded-full", modeInfo && RISK_DOT[modeInfo.risk])} />
                  <span className="truncate">{modeInfo?.label ?? mode}</span>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent className="max-w-[min(22rem,calc(100vw-2rem))]">
                  {info.modes.map((m) => (
                    <PromptInputSelectItem key={m.id} value={m.id} className="py-2">
                      <div className="flex items-start gap-2">
                        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", RISK_DOT[m.risk])} />
                        <div>
                          <div className="font-medium">{m.label}</div>
                          <div className="text-muted-foreground text-xs">{m.description}</div>
                        </div>
                      </div>
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
            {usage?.contextWindow ? (
              <Context
                maxTokens={usage.contextWindow}
                usedTokens={usage.contextTokens}
                usage={{
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.contextTokens,
                  inputTokenDetails: {
                    noCacheTokens: usage.inputTokens - (usage.cachedInputTokens ?? 0),
                    cacheReadTokens: usage.cachedInputTokens ?? 0,
                    cacheWriteTokens: undefined,
                  },
                  outputTokenDetails: {
                    textTokens: usage.outputTokens - (usage.reasoningTokens ?? 0),
                    reasoningTokens: usage.reasoningTokens ?? 0,
                  },
                  // Read by the Context rows (deprecated aliases in ai v6).
                  reasoningTokens: usage.reasoningTokens ?? 0,
                  cachedInputTokens: usage.cachedInputTokens ?? 0,
                }}
              >
                <ContextTrigger size="sm" className="h-8 rounded-full px-2 text-xs" />
                <ContextContent>
                  <ContextContentHeader />
                  <ContextContentBody>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                </ContextContent>
              </Context>
            ) : null}
            {info && info.models.length > 1 && <ModelSelect models={info.models} value={model} onChange={(v) => setModel(providerId, v)} />}
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            disabled={!connected || pending}
            onStop={() => currentId && interrupt(currentId)}
            className={cn("size-9 shrink-0 rounded-full text-white", style.bg, "hover:opacity-90")}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function ModelSelect({ models, value, onChange }: { models: { id: string; label: string; description?: string }[]; value: string; onChange: (v: string) => void }) {
  // Radix Select cannot use "" as a value.
  const v = value || "__default";
  const label = useMemo(() => models.find((m) => (m.id || "__default") === v)?.label ?? "Default", [models, v]);
  return (
    <PromptInputSelect value={v} onValueChange={(x) => onChange(x === "__default" ? "" : x)}>
      <PromptInputSelectTrigger className="h-8 min-w-0 rounded-full px-2.5 text-xs" aria-label="Model">
        <span className="truncate">{label}</span>
      </PromptInputSelectTrigger>
      <PromptInputSelectContent className="max-w-[min(22rem,calc(100vw-2rem))]">
        {models.map((m) => (
          <PromptInputSelectItem key={m.id || "__default"} value={m.id || "__default"} className="py-2">
            <div>
              <div className="font-medium">{m.label}</div>
              {m.description && <div className="line-clamp-2 text-muted-foreground text-xs">{m.description}</div>}
            </div>
          </PromptInputSelectItem>
        ))}
      </PromptInputSelectContent>
    </PromptInputSelect>
  );
}

function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton aria-label="Attach files" className="rounded-full" onClick={() => attachments.openFileDialog()}>
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}

function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (!attachments.files.length) return null;
  return (
    <PromptInputHeader className="px-3 pt-3">
      <Attachments variant="grid" className="gap-2">
        {attachments.files.map((f) => (
          <Attachment key={f.id} data={f} onRemove={() => attachments.remove(f.id)} className="size-16 rounded-xl">
            <AttachmentPreview />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}
