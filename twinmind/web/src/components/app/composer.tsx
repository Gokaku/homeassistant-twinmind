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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
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
import { currentMode, interrupt, sendMessage, setMode, setModel, setProvider, toast, useStore } from "@/lib/store";
import { CheckIcon, LogInIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
            <AssistantSelector />
            {info && (
              <PromptInputSelect value={mode} onValueChange={(v) => setMode(providerId, v)}>
                <PromptInputSelectTrigger aria-label="Permission mode" className="shrink-0 gap-1 px-2">
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {info.modes.map((m) => (
                    <PromptInputSelectItem key={m.id} value={m.id}>
                      {m.label}
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

/**
 * Who answers and with which model, in one AI Elements ModelSelector grouped by assistant.
 * Picking a model of the other assistant switches assistants (the transcript is handed over).
 */
function AssistantSelector() {
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.provider);
  const models = useStore((s) => s.models);
  const [open, setOpen] = useState(false);
  const current = providers.find((p) => p.id === providerId);
  if (!current) return null;
  const selectedModel = models[providerId] ?? "";
  const model = current.models.find((m) => m.id === selectedModel);
  // The logo already says which assistant it is: the button names the model.
  const shortLabel = model?.label ?? "Default";

  const select = (p: ProviderId, model: string) => {
    setProvider(p);
    setModel(p, model);
    setOpen(false);
  };

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <PromptInputButton aria-label={`Assistant and model: ${current.label}, ${shortLabel}`} className="min-w-0 shrink gap-1.5 px-2">
          <ModelSelectorLogo provider={PROVIDER_LOGO[providerId]} className="shrink-0" />
          <ModelSelectorName className="max-[374px]:hidden">{shortLabel}</ModelSelectorName>
        </PromptInputButton>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Assistant and model">
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {providers.map((p) => (
            <ModelSelectorGroup key={p.id} heading={p.auth.state === "signed-in" ? p.label : `${p.label} (not signed in)`}>
              {(p.models.length ? p.models : [{ id: "", label: "Default" }]).map((m) => {
                const selected = p.id === providerId && (models[p.id] ?? "") === m.id;
                return (
                  <ModelSelectorItem key={`${p.id}:${m.id}`} value={`${p.label} ${m.label} ${m.id}`} onSelect={() => select(p.id, m.id)}>
                    <ModelSelectorLogo provider={PROVIDER_LOGO[p.id]} />
                    <ModelSelectorName>{m.label}</ModelSelectorName>
                    {selected ? <CheckIcon className="ml-auto size-4" /> : <div className="ml-auto size-4" />}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
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
