import type { SessionEvent } from '../chat-protocol';
import type { TurnUi } from '../controller';
import type { Sensitivity } from './types';

export const CAPTURE_MARKER = 'agentbox-knowledge-proposal';

export interface CapturePayload {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sensitivity: Sensitivity;
}

export interface CaptureTranscript {
  userText: string;
  assistantText: string;
  text: string;
}

/**
 * Build a compact excerpt of the latest turn. The capture runtime gets this
 * as TurnInput.context, so it does not need the main thread or its history.
 */
export function buildCaptureTranscript(
  events: SessionEvent[]
): CaptureTranscript {
  let lastUser = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'user.message') {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return { userText: '', assistantText: '', text: '' };

  let userText = '';
  let assistantText = '';
  for (let index = lastUser; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === 'user.message') userText += `${event.text}\n`;
    else if (event.type === 'assistant.delta') assistantText += event.text;
  }
  userText = userText.trim().slice(0, 4_000);
  assistantText = assistantText.trim().slice(0, 12_000);
  return {
    userText,
    assistantText,
    text: [
      '<conversation>',
      'User:',
      userText,
      '',
      'Assistant:',
      assistantText,
      '</conversation>',
    ].join('\n'),
  };
}

export function buildCapturePrompt(): string {
  return [
    'You are AgentBox\'s built-in knowledge capture workflow.',
    'Read the conversation excerpt provided as context.',
    'Extract only reusable, factual knowledge: business rules, data/schema notes,',
    'operational decisions, troubleshooting conclusions, or project conventions.',
    'Do not include secrets, tokens, credentials, personal data, or transient logs.',
    'Do not invent facts that are not supported by the conversation.',
    'If there is nothing reusable, return {"empty":true}.',
    '',
    'Return exactly one fenced block and nothing else:',
    '',
    '```' + CAPTURE_MARKER,
    '{"title":"...","summary":"...","content":"Markdown body","tags":["..."],"sensitivity":"internal"}',
    '```',
    '',
    'The content must be self-contained Markdown suitable for future retrieval.',
    'Do not call tools. Do not modify files.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSensitivity(value: unknown): Sensitivity {
  return value === 'public' || value === 'secret' ? value : 'internal';
}

function parsePayload(value: unknown): CapturePayload | undefined {
  if (!isRecord(value) || value.empty === true) return undefined;
  if (
    typeof value.title !== 'string' ||
    value.title.trim() === '' ||
    typeof value.content !== 'string' ||
    value.content.trim() === ''
  ) {
    return undefined;
  }
  return {
    title: value.title.trim().slice(0, 200),
    summary:
      typeof value.summary === 'string' ? value.summary.trim().slice(0, 1_000) : '',
    content: value.content.trim(),
    tags: Array.isArray(value.tags)
      ? value.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [],
    sensitivity: normalizeSensitivity(value.sensitivity),
  };
}

export function parseCaptureResponse(text: string): CapturePayload | undefined {
  const fenced = new RegExp(
    '```' + CAPTURE_MARKER + '\\s*([\\s\\S]*?)```',
    'i'
  ).exec(text);
  const candidates: string[] = [];
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const payload = parsePayload(JSON.parse(candidate));
      if (payload !== undefined) return payload;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * A silent TurnUi for the capture runtime. It collects the model's final text
 * and denies any tool approval; capture must never execute workspace tools.
 */
export class CaptureTurnUi implements TurnUi {
  text = '';
  error: string | undefined;
  private resolveDone: (() => void) | undefined;
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  appendText(text: string): void {
    this.text += text;
  }

  appendEventLine(): void {
    // Capture is silent.
  }

  requestApproval(): Promise<'deny'> {
    return Promise.resolve('deny');
  }

  setBusy(): void {
    // Capture does not change the main UI busy state.
  }

  showError(message: string): void {
    this.error = message;
  }

  turnEnded(): void {
    this.resolveDone?.();
  }
}
