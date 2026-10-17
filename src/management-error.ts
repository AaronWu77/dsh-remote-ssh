/** Actionable management failures with stable HTTP and client-facing discriminants. */
export class RemoteSshManagementError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteSshManagementError'
  }
}
