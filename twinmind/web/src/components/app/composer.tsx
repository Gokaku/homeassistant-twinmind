import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from "@/components/ai-elements/attachments";
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
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { ProviderId } from "@/lib/protocol";
import {
  currentEffort,
  currentMode,
  currentModel,
  interrupt,
  sendMessage,
  setEffort,
  setMode,
  setModel,
  setProvider,
  toast,
  useStore,
} from "@/lib/store";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BrainIcon, CheckIcon, ChevronDownIcon, LogInIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PROVIDER_LOGO } from "./brand";

// Browser speech recognition (Chrome, Edge, Safari). Without it the mic could only record
// audio for a transcription service we do not have, so it is hidden instead of greyed out.
const canDictate = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

const isTouch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function Composer({ onOpenAccounts, suggestion }: { onOpenAccounts: () => void; suggestion: { text: string; n: number } | null }) {
  const providerId = useStore((s) => s.provider);
  const info = useStore((s) => s.providers.find((p) => p.id === s.provider));
  const mode = useStore((s) => currentMode(s));
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
  const modeInfo = info?.modes.find((m) => m.id === mode);
  const signedIn = info?.auth.state === "signed-in";

  useEffect(() => {
    if (suggestion) controller.textInput.setInput(suggestion.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion?.n]);

  const onSubmit = useCallback(async (msg: PromptInputMessage) => {
    if (!msg.text.trim() && msg.files.length === 0) return;
    if (runningRef.current) {
      toast("Wait for the reply to finish, or stop it first.", "info");
      throw new Error("busy"); // keeps the text in the box
    }
    const ok = await sendMessage(msg.text, msg.files.map((f) => ({ url: f.url, mediaType: f.mediaType, filename: f.filename })));
    if (!ok) throw new Error("not sent"); // keeps the text in the box
  }, []);

  const status = pending ? "submitted" : running ? "streaming" : undefined;

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-2 px-3 pb-safe">
      {info && !signedIn && (
        <Item variant="outline">
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
      )}
      {modeInfo?.risk === "danger" && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertDescription>
            <p>
              <b>{modeInfo.label}</b>: {modeInfo.description}
            </p>
          </AlertDescription>
        </Alert>
      )}
      <PromptInput
        onSubmit={onSubmit}
        globalDrop
        multiple
        maxFiles={10}
        maxFileSize={20 * 1024 * 1024}
        accept="image/*,text/*,.yaml,.yml,.json,.log,.txt,.md,.pdf,.csv,.xml"
        onError={(e) => toast(e.message)}
      >
        <PromptInputHeader>
          <PromptInputAttachmentsDisplay />
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea
            placeholder={`Message ${info?.label ?? "Twinmind"}…`}
            // On phones Enter adds a new line and the send button sends.
            submitOnEnter={!isTouch()}
            enterKeyHint={isTouch() ? "enter" : "send"}
          />
        </PromptInputBody>
        <PromptInputFooter className="gap-2">
          <PromptInputTools className="min-w-0 flex-1">
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger aria-label="Add attachments" />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            {canDictate && (
              <SpeechInput
                // It sits inside the form: without type="button" it would submit the message.
                type="button"
                aria-label="Dictate"
                lang={navigator.language || "en-US"}
                className="shrink-0"
                size="icon-sm"
                variant="ghost"
                onTranscriptionChange={(t) => {
                  const cur = controller.textInput.value;
                  controller.textInput.setInput(cur ? `${cur.replace(/\s+$/, "")} ${t}` : t);
                }}
              />
            )}
            <ChatSettings />
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
                <ContextTrigger />
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
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            disabled={!connected || pending || !signedIn}
            onStop={() => currentId && interrupt(currentId)}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

const EFFORT_SHORT: Record<string, string> = { minimal: "Min", medium: "Med", xhigh: "XHigh" };

interface ButtonText {
  model?: string;
  effort?: string;
  mode?: string;
}

const TRIGGER_CLASS = "justify-start gap-1.5 whitespace-nowrap px-2";

function TriggerText({ text, logo }: { text: ButtonText; logo: ReactNode }) {
  return (
    <>
      {logo}
      {text.model && <ModelSelectorName className="flex-none">{text.model}</ModelSelectorName>}
      {text.effort && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <BrainIcon className="size-3.5" />
          {text.effort}
        </span>
      )}
      {text.mode && <span className="text-muted-foreground">· {text.mode}</span>}
      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </>
  );
}

/**
 * The composer button for ChatSettings. All variants are rendered invisibly to measure them;
 * the button shows the first one that fits in the room the other composer tools leave.
 */
function FittingTrigger({ variants, logo, ariaLabel }: { variants: ButtonText[]; logo: ReactNode; ariaLabel: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const key = JSON.stringify(variants);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const tools = button?.parentElement;
    const measure = measureRef.current;
    if (!button || !tools || !measure) return;
    const fit = () => {
      const style = getComputedStyle(tools);
      const gap = parseFloat(style.columnGap) || 0;
      const items = [...tools.children].filter((c) => c !== measure && getComputedStyle(c).position !== "absolute" && getComputedStyle(c).position !== "fixed");
      const others = items.filter((c) => c !== button).reduce((sum, c) => sum + (c as HTMLElement).offsetWidth, 0);
      const room = tools.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - others - gap * (items.length - 1);
      const widths = [...measure.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      const i = widths.findIndex((w) => w <= room + 0.5);
      setLevel(i < 0 ? widths.length - 1 : i);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(tools);
    for (const c of tools.children) if (c !== measure) ro.observe(c);
    // Tools that appear later (the context ring) change the room as well.
    const mo = new MutationObserver(() => {
      for (const c of tools.children) if (c !== measure) ro.observe(c);
      fit();
    });
    mo.observe(tools, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [key]);

  return (
    <>
      <ModelSelectorTrigger asChild>
        <PromptInputButton ref={buttonRef} size="sm" aria-label={ariaLabel} className={cn(TRIGGER_CLASS, "min-w-0 shrink overflow-hidden")}>
          <TriggerText text={variants[Math.min(level, variants.length - 1)]} logo={logo} />
        </PromptInputButton>
      </ModelSelectorTrigger>
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible fixed top-0 left-0 flex w-max flex-col items-start">
        {variants.map((v, i) => (
          <PromptInputButton key={i} size="sm" tabIndex={-1} className={TRIGGER_CLASS}>
            <TriggerText text={v} logo={logo} />
          </PromptInputButton>
        ))}
      </div>
    </>
  );
}

/**
 * Who answers, with which model, how much it thinks, and what it may do: one button in the
 * composer (room for the text on phones) that opens all of it in one AI Elements ModelSelector.
 * Picking a model of the other assistant switches assistants (the transcript is handed over).
 */
function ChatSettings() {
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.provider);
  const mode = useStore((s) => currentMode(s));
  // The model a message would go to now: the picked one, or the assistant's default.
  const model = useStore((s) => currentModel(s));
  const effort = useStore((s) => currentEffort(s));
  const [open, setOpen] = useState(false);
  const current = providers.find((p) => p.id === providerId);
  if (!current) return null;
  const modelLabel = model?.label ?? "Default";
  // Every Codex model is "GPT-…" and the logo already says OpenAI: on phones keep the part that differs.
  const brandPrefix = /^GPT-(?=.)/i.exec(modelLabel)?.[0] ?? "";
  const effortLabel = model?.efforts?.find((e) => e.id === effort)?.label ?? effort;
  const modeInfo = current.modes.find((m) => m.id === mode);
  const summary = [modelLabel, effortLabel && `${effortLabel} thinking`, modeInfo?.label].filter(Boolean).join(", ");

  // What the button says, from most to least detailed. The button shows the most detailed one
  // that fits completely: words are left out, never cut off.
  const variants: ButtonText[] = [
    { model: modelLabel, effort: effortLabel, mode: modeInfo?.label },
    { model: modelLabel, effort: effort && (EFFORT_SHORT[effort] ?? effortLabel), mode: modeInfo?.label },
    { model: modelLabel.slice(brandPrefix.length), effort: effort && (EFFORT_SHORT[effort] ?? effortLabel), mode: modeInfo?.label },
    // The mode matters more than the thinking level (it decides what runs without asking).
    { model: modelLabel.slice(brandPrefix.length), mode: modeInfo?.label },
    { model: modelLabel.slice(brandPrefix.length), effort: effort && (EFFORT_SHORT[effort] ?? effortLabel) },
    { model: modelLabel.slice(brandPrefix.length) },
    {},
  ];

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <FittingTrigger
        variants={variants}
        logo={<ModelSelectorLogo provider={PROVIDER_LOGO[providerId]} className="shrink-0" />}
        ariaLabel={`${current.label}: ${summary}`}
      />
      <ModelSelectorContent title="Assistant, model and mode" className="max-h-[calc(100dvh-1rem)] overflow-y-auto">
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList className="max-h-[min(300px,40dvh)]">
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {/* The current assistant first, so its models are in view when the list opens. */}
          {[current, ...providers.filter((p) => p !== current)].map((p) => (
            <ModelSelectorGroup key={p.id} heading={p.auth.state === "signed-in" ? p.label : `${p.label} (not signed in)`}>
              {(p.models.length ? p.models : [{ id: "", label: "Default" }]).map((m) => {
                const isSelected = p.id === providerId && m.id === (model?.id ?? "");
                return (
                  <ModelSelectorItem
                    key={`${p.id}:${m.id}`}
                    value={`${p.label} ${m.label} ${m.id}`}
                    onSelect={() => {
                      setProvider(p.id);
                      setModel(p.id, m.id);
                    }}
                  >
                    <ModelSelectorLogo provider={PROVIDER_LOGO[p.id]} />
                    <ModelSelectorName>{m.label}</ModelSelectorName>
                    {m.isDefault && <span className="text-xs text-muted-foreground">recommended</span>}
                    {isSelected ? <CheckIcon className="ml-auto size-4" /> : <div className="ml-auto size-4" />}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
        <div className="grid gap-4 border-t p-4">
          {model?.efforts?.length && effort ? (
            <div className="grid gap-2">
              <Label id="tm-effort">Thinking</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={1}
                aria-labelledby="tm-effort"
                className="grid w-full grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]"
                value={effort}
                onValueChange={(v) => v && setEffort(providerId, v)}
              >
                {model.efforts.map((e) => (
                  <ToggleGroupItem key={e.id} value={e.id} title={e.description} className="w-full px-2.5">
                    {e.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="tm-mode">Permission mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(providerId, v)}>
              <SelectTrigger id="tm-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {current.modes.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modeInfo && <p className="text-muted-foreground text-xs">{modeInfo.description}</p>}
          </div>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </div>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const PromptInputAttachmentsDisplay = () => {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <Attachments variant="inline">
      {attachments.files.map((a) => (
        <Attachment key={a.id} data={a} onRemove={() => attachments.remove(a.id)}>
          <AttachmentPreview />
          <AttachmentInfo className="max-w-32" />
          {/* Upstream shows it on hover only: keep it visible on touch screens and when focused. */}
          <AttachmentRemove
            label={`Remove ${a.filename ?? "attachment"}`}
            className="focus-visible:opacity-100 pointer-coarse:opacity-100"
          />
        </Attachment>
      ))}
    </Attachments>
  );
};
