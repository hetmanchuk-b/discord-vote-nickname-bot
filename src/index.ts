import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './load-commands.js';
import ready from './events/ready.js';
import interactionCreate from './events/interaction-create.js';
import { disconnectReputationDatabase } from './reputation/database.js';
import { attachVoiceTracking } from './reputation/voice-tracking.js';
import { createMemberReputation } from './reputation/member-reputation.js';
import { createReportNavigation } from './reputation/reporting.js';
import { attachVoicePolls } from './reputation/voice-poll-discord.js';
import { attachMovies } from './movies/discord.js';

const { token } = loadConfig();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessagePolls,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

client.commands = loadCommands();
client.cooldowns = new Collection();
client.shuffleSessions = new Collection();
client.once(ready.name, ready.execute);
client.on(interactionCreate.name, interactionCreate.execute);
const voiceTracking = attachVoiceTracking(client);
const voicePolls = attachVoicePolls(client, () => voiceTracking.tracker?.checkpoint() ?? Promise.resolve());
client.voicePolls = voicePolls.runtime;
const movies = attachMovies(client);
client.movies = movies.runtime;
client.reputationReports = createReportNavigation(async (guildId, channelId) => {
  if (voiceTracking.guildId === guildId) await voiceTracking.reporting?.channelChanged(channelId);
});
client.reputation = createMemberReputation({
  getTracker: guildId => voiceTracking.guildId === guildId ? voiceTracking.tracker : undefined,
  onDeleted: () => voicePolls.runtime.refresh(),
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const results = await Promise.allSettled([voiceTracking.stop(), voicePolls.stop(), movies.stop()]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Bot shutdown incomplete.');
  } catch {
    console.error('Could not finish background work during shutdown.');
    process.exitCode = 1;
  } finally {
    client.destroy();
    try {
      await disconnectReputationDatabase();
    } catch {
      console.error('Could not close database connections cleanly.');
      process.exitCode = 1;
    }
  }
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

client.login(token).catch(console.error);
