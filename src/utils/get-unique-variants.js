module.exports = function getUniqueVariants(messages) {
  const variants = new Map();

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