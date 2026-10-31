import { describe, expect, it } from 'vitest';
import { TurnTimeline } from '../src/webview/timeline';

describe('TurnTimeline', () => {
  it('splits thinking, generation and tool phases', () => {
    const timeline = new TurnTimeline();
    timeline.begin(1_000);
    expect(timeline.textDelta(1_100)).toBe(true);
    expect(timeline.textDelta(1_200)).toBe(false);
    timeline.toolStart(1_500, 'c1', 'commandExecution', 'Get-ChildItem');
    timeline.toolEnd(1_800, 'c1', true);
    expect(timeline.textDelta(1_900)).toBe(true);
    timeline.approvalWait(1_950);

    expect(timeline.snapshot(2_000)).toEqual([
      { kind: 'thinking', start: 1_000, end: 1_100, label: '思考' },
      { kind: 'generation', start: 1_100, end: 1_500, label: '生成' },
      {
        kind: 'tool',
        start: 1_500,
        end: 1_800,
        label: 'commandExecution',
        ok: true,
        callId: 'c1',
        summary: 'Get-ChildItem',
      },
      { kind: 'thinking', start: 1_800, end: 1_900, label: '思考' },
      { kind: 'generation', start: 1_900, end: 1_950, label: '生成' },
      { kind: 'thinking', start: 1_950, end: 2_000, label: '思考' },
    ]);
  });

  it('marks failed tools', () => {
    const timeline = new TurnTimeline();
    timeline.begin(1_000);
    timeline.toolStart(1_100, 'c1', 'commandExecution', 'Remove-Item');
    timeline.toolEnd(1_400, 'c1', false);
    timeline.finish(1_600);

    expect(timeline.snapshot(2_500)).toEqual([
      { kind: 'thinking', start: 1_000, end: 1_100, label: '思考' },
      {
        kind: 'tool',
        start: 1_100,
        end: 1_400,
        label: 'commandExecution',
        ok: false,
        callId: 'c1',
        summary: 'Remove-Item',
      },
      { kind: 'thinking', start: 1_400, end: 1_600, label: '思考' },
    ]);
    expect(timeline.end).toBe(1_600);
    expect(timeline.running).toBe(false);
  });

  it('extends open phases and tools while the turn is running', () => {
    const timeline = new TurnTimeline();
    timeline.begin(1_000);
    timeline.textDelta(1_200);
    timeline.toolStart(1_500, 'c1', 'read_file', 'a.txt');

    expect(timeline.snapshot(1_600)).toEqual([
      { kind: 'thinking', start: 1_000, end: 1_200, label: '思考' },
      { kind: 'generation', start: 1_200, end: 1_500, label: '生成' },
      {
        kind: 'tool',
        start: 1_500,
        end: 1_600,
        label: 'read_file',
        ok: true,
        callId: 'c1',
        summary: 'a.txt',
      },
    ]);
  });

  it('closes open spans on finish and resets cleanly', () => {
    const timeline = new TurnTimeline();
    timeline.begin(1_000);
    timeline.toolStart(1_100, 'c1', 'run_shell', 'Get-ChildItem');
    timeline.finish(1_500);

    expect(timeline.snapshot(9_999)).toEqual([
      { kind: 'thinking', start: 1_000, end: 1_100, label: '思考' },
      {
        kind: 'tool',
        start: 1_100,
        end: 1_500,
        label: 'run_shell',
        ok: true,
        callId: 'c1',
        summary: 'Get-ChildItem',
      },
    ]);
    expect(timeline.duration(9_999)).toBe(500);

    timeline.reset();
    expect(timeline.started).toBe(false);
    expect(timeline.snapshot(9_999)).toEqual([]);
    expect(timeline.duration(9_999)).toBe(0);
  });

  it('starts a fresh timeline for each turn', () => {
    const timeline = new TurnTimeline();
    timeline.begin(1_000);
    timeline.toolStart(1_100, 'c1', 'old');
    timeline.begin(5_000);

    expect(timeline.snapshot(5_500)).toEqual([
      { kind: 'thinking', start: 5_000, end: 5_500, label: '思考' },
    ]);
  });
});
