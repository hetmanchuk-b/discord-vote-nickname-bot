import type { MessageWithReactions, Variant } from '../types.js';

export default function getUniqueVariants(messages: MessageWithReactions[]): Variant[] {
  const variants = new Map<string, Variant>();

  for (const { message, reactionCount } of messages) {
    const variant = message.content.trim();

    if (!variant) continue;

    const normalized = variant
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase();

    const existing = variants.get(normalized);

    if (!existing || reactionCount > existing.reactionCount) {
      variants.set(normalized, {
        text: variant,
        reactionCount,
      });
    }
  }

  return [...variants.values()];
};