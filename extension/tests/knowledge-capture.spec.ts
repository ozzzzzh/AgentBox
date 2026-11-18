import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/chat-protocol';
import {
  buildCapturePrompt,
  buildCaptureTranscript,
  CaptureTurnUi,
  parseCaptureResponse,
} from '../src/knowledge/capture';

describe('knowledge capture prompt and parser', () => {
  it('contains the proposal marker and schema', () => {
    const prompt = buildCapturePrompt();
    expect(prompt).toContain('agentbox-knowledge-proposal');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('Do not call tools');
  });

  it('builds context from the latest turn only', () => {
    const events: SessionEvent[] = [
      { type: 'user.message', text: 'old question' },
      { type: 'assistant.delta', text: 'old answer' },
      { type: 'user.message', text: 'new question' },
      { type: 'assistant.delta', text: 'new ' },
      { type: 'assistant.delta', text: 'answer' },
      { type: 'turn.end', reason: 'completed' },
    ];
    const transcript = buildCaptureTranscript(events);
    expect(transcript.userText).toBe('new question');
    expect(transcript.assistantText).toBe('new answer');
    expect(transcript.text).not.toContain('old question');
    expect(transcript.text).toContain('<conversation>');
  });

  it('parses a fenced proposal', () => {
    const payload = parseCaptureResponse(
      [
        '```agentbox-knowledge-proposal',
        JSON.stringify({
          title: '增量同步',
          summary: '排查 watermark',
          content: '# 增量同步\n\n先校验 watermark。',
          tags: ['etl'],
          sensitivity: 'internal',
        }),
        '```',
      ].join('\n')
    );
    expect(payload).toMatchObject({
      title: '增量同步',
      tags: ['etl'],
      sensitivity: 'internal',
    });
    expect(payload?.content).toContain('watermark');
  });

  it('parses a bare JSON object and rejects empty payloads', () => {
    expect(
      parseCaptureResponse(
        'result: {"title":"A","content":"body","sensitivity":"public"}'
      )
    ).toMatchObject({ title: 'A', sensitivity: 'public' });
    expect(parseCaptureResponse('{"empty":true}')).toBeUndefined();
    expect(parseCaptureResponse('not json')).toBeUndefined();
  });

  it('resolves the silent capture UI on turn end', async () => {
    const ui = new CaptureTurnUi();
    ui.appendText('hello');
    ui.appendEventLine('ignored');
    ui.showError('none');
    ui.turnEnded();
    await expect(ui.done).resolves.toBeUndefined();
    expect(ui.text).toBe('hello');
  });
});
