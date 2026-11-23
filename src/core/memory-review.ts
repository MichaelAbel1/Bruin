import { z } from 'zod';
import type { SessionEvent } from './types.js';

type ReviewEvent = Pick<SessionEvent, 'seq' | 'at' | 'payload'> & { type: string };

export type MemoryReviewTurn = {
  startSeq: number;
  endSeq: number;
  at: string;
  label: string;
};

export function memoryReviewTurns(events: readonly ReviewEvent[]): MemoryReviewTurn[] {
  const turns: MemoryReviewTurn[] = [];
  let user: ReviewEvent | undefined;
  for (const event of events) {
    if (event.type === 'workspace_changed') {
      turns.length = 0;
      user = undefined;
    } else if (event.type === 'user') {
      user ??= event;
    } else if (event.type === 'turn_completed') {
      if (user && !event.payload.stoppedByUser && !event.payload.awaitingPlanApproval)
        turns.push({
          startSeq: user.seq,
          endSeq: event.seq,
          at: event.at,
          label: String(user.payload.text ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
        });
      user = undefined;
    }
  }
  return turns;
}

export type MemoryEvidence =
  | { seq: number; kind: 'user'; text: string }
  | {
      seq: number;
      kind: 'shell';
      commandSeq: number;
      text: string;
      exitCode: number;
      isError: boolean;
    };

export function memoryReviewEvidence(
  events: readonly ReviewEvent[],
  turn: MemoryReviewTurn,
  redact: (text: string) => string,
): MemoryEvidence[] {
  const messages: MemoryEvidence[] = [];
  const results: MemoryEvidence[] = [];
  const commands = new Map<string, { seq: number; text: string }>();
  for (const { seq, type, payload } of events) {
    if (seq < turn.startSeq || seq >= turn.endSeq) continue;
    if (type === 'user' && typeof payload.text === 'string' && payload.text.trim()) {
      messages.push({ seq, kind: 'user', text: redact(payload.text).slice(0, 600) });
    }
    if (payload.name !== 'shell' || typeof payload.callId !== 'string') continue;
    if (type === 'tool_requested') {
      commands.delete(payload.callId);
      const command = (payload.input as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string') {
        const text = redact(command);
        if (text.length <= 400) commands.set(payload.callId, { seq, text });
      }
    }
    if (type === 'tool_finished' || type === 'tool_denied' || type === 'tool_unknown') {
      const command = commands.get(payload.callId);
      commands.delete(payload.callId);
      if (
        type === 'tool_finished' &&
        command &&
        Number.isSafeInteger(payload.exitCode) &&
        typeof payload.isError === 'boolean'
      )
        results.push({
          seq,
          kind: 'shell',
          commandSeq: command.seq,
          text: command.text,
          exitCode: payload.exitCode as number,
          isError: payload.isError,
        });
    }
  }
  return [...messages.slice(-8), ...results.slice(-8)].sort((a, b) => a.seq - b.seq);
}

export const memoryCandidateSchema = z
  .array(
    z.object({
      key: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
      content: z.string().trim().min(1).max(1800),
      evidenceSeqs: z.array(z.number().int().positive()).min(1).max(4),
    }),
  )
  .max(3);

export type MemoryCandidatePreview = {
  key: string;
  content: string;
  previousContent?: string;
  evidence: MemoryEvidence[];
};

export type MemoryReviewPreview = { id: string; candidates: MemoryCandidatePreview[] };
