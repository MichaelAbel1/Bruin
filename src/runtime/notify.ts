import { isAllowedWebhookUrl, loadConfig } from '../config.js';
import type { SessionPhase } from '../core/session-state.js';

export { isAllowedWebhookUrl };

export type AttentionEventKind =
  'awaiting_input' | 'awaiting_approval' | 'paused' | 'awaiting_review' | 'run_failed';

export type AttentionPayload = {
  event: AttentionEventKind;
  sessionId: string;
  workspace: string;
  phase: SessionPhase;
  reason?: string;
  questionId?: string;
  question?: string;
  options?: string[];
  approvalId?: string;
  toolName?: string;
  at: string;
};

export function redactWebhookText(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  const sortedSecrets = [...new Set(extraSecrets.filter((secret) => secret.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of sortedSecrets) {
    out = out.replaceAll(secret, '[REDACTED]');
  }
  return out
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /\b([\w.-]*(?:password|passphrase|api[_-]?key|secret|token|credential|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
}

export function resolveWebhookUrl(override?: string): string | undefined {
  let candidate = override?.trim() || process.env.BRUIN_WEBHOOK_URL?.trim();
  if (!candidate) {
    try {
      candidate = loadConfig().webhookUrl?.trim();
    } catch {
      return undefined;
    }
  }
  if (!candidate || !isAllowedWebhookUrl(candidate)) return undefined;
  return candidate;
}

/** Best-effort outbound webhook notifying a human when a run needs attention.
 * Redacts credentials/secrets before posting, drains response bodies, and never throws. */
export async function sendAttentionWebhook(
  payload: Omit<AttentionPayload, 'at'> & { at?: string },
  options: {
    webhookUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    extraSecrets?: readonly string[];
  } = {},
): Promise<boolean> {
  const url = resolveWebhookUrl(options.webhookUrl);
  if (!url) return false;
  const redact = (value: string, max: number) =>
    redactWebhookText(value, options.extraSecrets).slice(0, max);
  const body: AttentionPayload = {
    event: payload.event,
    sessionId: payload.sessionId,
    workspace: payload.workspace,
    phase: payload.phase,
    ...(payload.reason ? { reason: redact(payload.reason, 1_000) } : {}),
    ...(payload.questionId ? { questionId: payload.questionId } : {}),
    ...(payload.question ? { question: redact(payload.question, 1_000) } : {}),
    ...(payload.options?.length
      ? { options: payload.options.slice(0, 6).map((item) => redact(item, 200)) }
      : {}),
    ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
    ...(payload.toolName ? { toolName: redact(payload.toolName, 120) } : {}),
    at: payload.at ?? new Date().toISOString(),
  };
  try {
    const fetchFn = options.fetchImpl ?? fetch;
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'bruin-agent/1',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    try {
      return response.ok;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  } catch {
    return false;
  }
}
