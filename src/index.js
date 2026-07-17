const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const {Player, GuildQueueEvent} = require('discord-player')
const {DefaultExtractors} = require('@discord-player/extractor')
const { token } = require('../data/config.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessagePolls,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

const player = new Player(client)

async function main() {
  await player.extractors.loadMulti(DefaultExtractors)

  client.commands = new Collection();
  const foldersPath = path.join(__dirname, 'commands');
  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
      } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
      }
    }
  }

  const eventsPath = path.join(__dirname, 'events');
  const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));
  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }

  client.cooldowns = new Collection();
  client.shuffleSessions = new Collection();

  player.events.on(GuildQueueEvent.PlayerStart, (queue, track) => {
    console.log('PlayerStart:', track.title);
  });

  player.events.on(GuildQueueEvent.PlayerError, (queue, error) => {
    console.error('PlayerError:', error);
  });

  player.events.on(GuildQueueEvent.Error, (queue, error) => {
    console.error('QueueError:', error);
  });

  player.events.on(GuildQueueEvent.Disconnect, () => {
    console.log('Disconnected');
  });

  player.events.on(GuildQueueEvent.EmptyChannel, () => {
    console.log('EmptyChannel');
  });

  player.events.on(GuildQueueEvent.EmptyQueue, () => {
    console.log('EmptyQueue');
  });

  player.events.on(GuildQueueEvent.Finish, () => {
    console.log('Finish');
  });

  player.events.on(GuildQueueEvent.AudioTrackAdd, (queue, track) => {
    console.log('Track added', track.title);
  });

  player.events.on(GuildQueueEvent.PlayerFinish, (queue, track) => {
    console.log('Finished', track.title);
  });

  client.login(token);
}

main().catch(console.error);