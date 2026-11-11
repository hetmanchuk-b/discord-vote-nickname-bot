import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  Collection,
  Message,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

import type { ReputationMembers } from './reputation/member-reputation.js';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  cooldown?: number;
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
}

export type ButtonHandler = (interaction: ButtonInteraction) => Promise<unknown>;

export interface Variant {
  text: string;
  reactionCount: number;
}

export interface MessageWithReactions {
  message: Message;
  reactionCount: number;
}

export interface ShuffleSession {
  availableVariants: Variant[];
  selectedVariants: Variant[];
  threadId: string;
}

// These collections are initialized before the client logs in.
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
    cooldowns: Collection<string, Collection<string, number>>;
    shuffleSessions: Collection<string, ShuffleSession>;
    reputation: ReputationMembers;
  }
}

export type ReadyClient = Client<true>;
