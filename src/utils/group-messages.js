module.exports = function (messages) {
  const result = new Map()
  for (const message of messages) {
    const user = message.member?.displayName ?? message.author.username
    if (!result.has(user)) {
      result.set(user, [])
    }
    result.get(user).push(message.content)
  }
  return result
}