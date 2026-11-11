import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../types.js';
import { penaltyFeedback } from '../reputation/voice-penalty-command.js';

export const handleVoicePenalty: ButtonHandler = async interaction => {
  const match = /^voice-(penalty|reward):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(yes|no)$/.exec(interaction.customId);
  if (!match || !interaction.guildId || interaction.user.bot) return interaction.reply({content:'❌ Некоректне голосування.',flags:MessageFlags.Ephemeral});
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  try {
    const selected = await interaction.client.voicePenalties.vote({interactionId:interaction.id,kind:match[1] === 'reward' ? 'reward' : 'penalty',id:match[2],guildId:interaction.guildId,textChannelId:interaction.channelId,
      messageId:interaction.message.id,userId:interaction.user.id,yes:match[3]==='yes'});
    return interaction.editReply({content:`✅ Ваш голос збережено: **${selected ? 'Так' : 'Ні'}**. Вибір можна змінити до завершення; для зарахування залишайтеся в початковому голосовому каналі.`,allowedMentions:{parse:[]}});
  } catch(error) { return interaction.editReply({content:penaltyFeedback(error),allowedMentions:{parse:[]}}); }
};
