import type { Message } from 'discord.js';

export default function groupMessages(messages: Message[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const message of messages) {
    const user = message.member?.displayName ?? message.author.username
    const variants = result.get(user) ?? []
    variants.push(message.content)
    result.set(user, variants)
  }
  return result
}