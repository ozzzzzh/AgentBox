export type RuntimeErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_CONFIG'
  | 'INVALID_RUNTIME'
  | 'INVALID_ARGUMENT'
  | 'SPAWN_FAILED'
  | 'HANDSHAKE_FAILED'
  | 'SANDBOX_NOT_CONFIGURED'
  | 'PROTOCOL_ERROR'
  | 'NOT_RUNNING'
  | 'TURN_NOT_FOUND'
  | 'TURN_IN_PROGRESS'
  | 'APPROVAL_NOT_PENDING'
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
