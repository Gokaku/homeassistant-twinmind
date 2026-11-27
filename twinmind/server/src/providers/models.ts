import type { ModelInfo } from "../protocol.js";

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export const effortLabel = (e: string) => EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/**
 * The model and thinking level a turn runs with. Both are always sent explicitly: Codex keeps
 * a thread's last model and effort when a turn leaves them out, so "the default" would
 * otherwise silently mean "whatever the previous turn used".
 */
export function pickModel(models: ModelInfo[], model?: string, effort?: string): { model: string | null; effort: string | null } {
  const m = models.find((x) => x.id === model) ?? models.find((x) => x.isDefault) ?? models[0];
  if (!m) return { model: model || null, effort: null };
  const e = m.efforts?.some((x) => x.id === effort) ? effort! : (m.defaultEffort ?? null);
  return { model: m.id, effort: e };
}
