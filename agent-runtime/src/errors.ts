export type RuntimeErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_CONFIG'
  | 'INVALID_RUNTIME'
  | 'SPAWN_FAILED'
  | 'HANDSHAKE_FAILED'
  | 'PROTOCOL_ERROR'
  | 'NOT_RUNNING'
  | 'TURN_NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'POLICY_DENIED'
  | 'RUNTIME_EXITED';

/**
 * Runtime-level error. Adapters must translate their protocol errors
 * into a RuntimeError with one of the codes above.
 */
export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}
