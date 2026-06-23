module.exports = function (messages) {
  const variants = new Map()

  for (const message of messages) {
    const variant = message.content.trim()

    if (!variant) continue

    const normalized = variant.trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase()

    if (!variants.has(normalized)) {
      variants.set(normalized, variant)
    }
  }

  return [...variants.values()]
}