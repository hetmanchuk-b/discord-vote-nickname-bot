import fs from 'node:fs';
import path from 'node:path';
import { Collection } from 'discord.js';
import type { Command } from './types.js';

export function loadCommands(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  const foldersPath = path.join(__dirname, 'commands');
  for (const folder of fs.readdirSync(foldersPath)) {
    const commandsPath = path.join(foldersPath, folder);
    for (const file of fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'))) {
      const filePath = path.join(commandsPath, file);
      const { default: command } = require(filePath) as { default: Command };
      if (command?.data && typeof command.execute === 'function') {
        commands.set(command.data.name, command);
      } else {
        throw new Error(`Invalid command module: ${filePath}`);
      }
    }
  }
  return commands;
}
