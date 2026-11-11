export class PublicationPendingError extends Error {
  constructor() { super('A report containing this member is awaiting publication confirmation.'); }
}
