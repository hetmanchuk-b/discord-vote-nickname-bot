module.exports = async function fetchAllVariantsWithReactions(thread) {
  const variants = [];
  let before;

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
      .map((msg) => ({
        message: msg,
        reactionCount: [...msg.reactions.cache.values()]
          .reduce((sum, reaction) => sum + reaction.count, 0),
      }));

    variants.push(...messages);

    before = fetched.lastKey();
  }

  return variants.reverse();
};