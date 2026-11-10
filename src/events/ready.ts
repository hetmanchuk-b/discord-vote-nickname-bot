import { Events } from 'discord.js';
import type { ReadyClient } from '../types.js';

export default {
  name: Events.ClientReady as const,
  once: true,
  execute(client: ReadyClient) {
    console.log(`Ready! Logged in as ${client.user.tag}`);
  },
};
