export const DELETION_CONFIRMATION_MS = 60_000;
export const DELETE_CONFIRM_ID = 'reputation:delete:confirm';
export const DELETE_CANCEL_ID = 'reputation:delete:cancel';

interface Confirmation {
  messageId: string;
  guildId: string;
  userId: string;
  expiresAt: number;
  onExpire(): Promise<unknown>;
}

interface PendingConfirmation extends Confirmation {
  timer: NodeJS.Timeout;
}

// Intentionally transient: a process restart invalidates outstanding destructive
// confirmations. No user-supplied custom ID can authorize deleting another member.
export class DeletionConfirmations {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly now: () => number = Date.now) {}

  create(confirmation: Confirmation): void {
    const old = this.pending.get(confirmation.messageId);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => this.expire(confirmation.messageId), Math.max(0, confirmation.expiresAt - this.now()));
    timer.unref();
    this.pending.set(confirmation.messageId, { ...confirmation, timer });
  }

  consume(messageId: string, guildId: string, userId: string): 'confirmed' | 'missing' | 'forbidden' | 'expired' {
    const confirmation = this.pending.get(messageId);
    if (!confirmation) return 'missing';
    if (confirmation.guildId !== guildId || confirmation.userId !== userId) return 'forbidden';
    if (this.now() >= confirmation.expiresAt) {
      this.expire(messageId);
      return 'expired';
    }
    this.pending.delete(messageId); // Consume before awaiting any Discord/DB calls.
    clearTimeout(confirmation.timer);
    return 'confirmed';
  }

  private expire(messageId: string): void {
    const confirmation = this.pending.get(messageId);
    if (!confirmation) return;
    if (this.now() < confirmation.expiresAt) {
      confirmation.timer = setTimeout(() => this.expire(messageId), confirmation.expiresAt - this.now());
      confirmation.timer.unref();
      return;
    }
    this.pending.delete(messageId);
    clearTimeout(confirmation.timer);
    try {
      void confirmation.onExpire().catch(() => {});
    } catch {
      // Deleted/expired ephemeral messages and stale callback contexts are harmless.
    }
  }
}

export const deletionConfirmations = new DeletionConfirmations();
