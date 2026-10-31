/**
 * Test-only entry point (`@agentbox/runtime/testing`).
 *
 * Exports the scriptable FakeRuntime for consumer tests and the V1 VSIX
 * walking skeleton. The vitest-based contract suite is intentionally not
 * exported here.
 */
export { FakeRuntime } from './fake-runtime.js';
export type {
  FakeRuntimeOptions,
  FakeStep,
  FakeTurnScript,
} from './fake-runtime.js';
