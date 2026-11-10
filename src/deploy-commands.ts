import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './load-commands.js';

const { clientId, token } = loadConfig();
const commands = [...loadCommands().values()].map(command => command.data.toJSON());
const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);
    const data = await rest.put(Routes.applicationCommands(clientId), { body: commands });
    if (!Array.isArray(data)) throw new Error('Unexpected command deployment response.');
    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
