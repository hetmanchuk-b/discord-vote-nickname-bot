import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './load-commands.js';
import ready from './events/ready.js';
import interactionCreate from './events/interaction-create.js';

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

client.login(token).catch(console.error);
