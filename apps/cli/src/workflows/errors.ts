export class WorkflowInterruptedError extends Error {
  public constructor(message = 'Operation was interrupted.') {
    super(message);
    this.name = 'WorkflowInterruptedError';
  }
}
