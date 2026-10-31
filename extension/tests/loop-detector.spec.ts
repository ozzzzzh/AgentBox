import { describe, expect, it } from 'vitest';
import { ToolLoopDetector } from '../src/loop-detector';

describe('ToolLoopDetector', () => {
  it('stops after the same tool call fails repeatedly', () => {
    const detector = new ToolLoopDetector({ maxRepeatedFailures: 2 });

    detector.toolStart('c1', 'run_shell', { command: 'Get-ChildItem' });
    expect(detector.toolEnd('c1', false).loop).toBe(false);
    detector.toolStart('c2', 'run_shell', { command: 'Get-ChildItem' });
    const result = detector.toolEnd('c2', false);

    expect(result.loop).toBe(true);
    expect(result.reason).toContain('相同工具调用');
  });

  it('resets the repeated count after a success', () => {
    const detector = new ToolLoopDetector({ maxRepeatedFailures: 2 });

    detector.toolStart('c1', 'run_shell', { command: 'npm test' });
    expect(detector.toolEnd('c1', false).loop).toBe(false);
    detector.toolStart('c2', 'run_shell', { command: 'npm test' });
    expect(detector.toolEnd('c2', true).loop).toBe(false);
    detector.toolStart('c3', 'run_shell', { command: 'npm test' });
    expect(detector.toolEnd('c3', false).loop).toBe(false);
  });

  it('stops after consecutive failures across different calls', () => {
    const detector = new ToolLoopDetector({
      maxRepeatedFailures: 10,
      maxConsecutiveFailures: 3,
    });

    for (let index = 0; index < 2; index += 1) {
      detector.toolStart(`c${index}`, 'tool', { index });
      expect(detector.toolEnd(`c${index}`, false).loop).toBe(false);
    }
    detector.toolStart('c3', 'tool', { index: 3 });
    const result = detector.toolEnd('c3', false);

    expect(result.loop).toBe(true);
    expect(result.reason).toContain('连续');
  });

  it('reset clears all state', () => {
    const detector = new ToolLoopDetector({ maxRepeatedFailures: 2 });
    detector.toolStart('c1', 'tool', {});
    detector.toolEnd('c1', false);
    detector.reset();

    detector.toolStart('c2', 'tool', {});
    expect(detector.toolEnd('c2', false).loop).toBe(false);
  });
});
