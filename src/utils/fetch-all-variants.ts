import type { Message, ThreadChannel } from 'discord.js';

export default async function fetchAllVariants(thread: ThreadChannel): Promise<Message[]> {
  const variants: Message[] = [];
  let before: string | undefined;

  while (true) {
    const fetched = await thread.messages.fetch({limit: 100, ...(before && { before })});

    if (fetched.size === 0) break;

    const messages = [...fetched.values()]
      .filter(
        (msg) =>
          !msg.author.bot
          && !msg.system
          && typeof msg.content === "string"
          && msg.content.trim().length > 0
      )

    variants.push(...messages);

    before = fetched.lastKey();
  }

  return variants.reverse();
}