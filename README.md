# Vote Nickname Discord Bot

A simple Discord bot for starting nickname voting threads on a Discord server.

## Features

- Slash command for starting a nickname vote
- Creates a dedicated thread for nickname suggestions
- Supports Discord application command deployment
- Written in strict TypeScript using Discord.js
- Reaction-weighted, interactive finalist selection and 24-hour Discord polls
- Archive notes, download social-media videos, and generate playful percentage ratings

## Requirements

- Node.js 22.12+ (Node.js 24 LTS recommended)
- npm
- A Discord bot token
- Discord application client ID

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a configuration file at:

   ```text
   data/config.json
   ```

3. Add your Discord bot token and client ID:

   ```json
   {
     "token": "YOUR_DISCORD_BOT_TOKEN",
     "clientId": "YOUR_DISCORD_APPLICATION_CLIENT_ID"
   }
   ```

4. Deploy slash commands:

   ```bash
   npm run commands
   ```

5. Start the bot:

   ```bash
   npm run start
   ```

## Usage

Use the `/nickname-start` slash command in a server text channel to start a nickname vote for a selected user.
The bot will create a thread where users can suggest nickname variants.

Use the `/nickname-variants` or `/nickname-variants-by` slash command to view current variants.

Use `/nickname-end` in the suggestion thread to open interactive finalist selection. Reactions increase a suggestion's selection weight. Use the buttons to select 5–10 finalists, remove the last selection, or create a 24-hour poll.

Use the `/nickname-manage-result` slash command to end the poll and set the final nickname for the selected member.

## Development

```bash
npm run typecheck  # Strict TypeScript checks without emitting files
npm run lint       # ESLint, including TypeScript rules
npm test           # Build and run offline smoke/unit tests
npm run build      # Compile src/ into dist/
```

`npm start` and `npm run commands` build automatically before running the compiled entry points. The project retains CommonJS output; TypeScript imports use `.js` extensions for runtime compatibility. Command modules are discovered from `dist/commands/`; event handlers are registered in `src/index.ts`.

Configuration is read from `data/config.json` at runtime, relative to the project root, and is not copied into `dist/`. Keep that file alongside `dist/` when deploying. Never commit the bot token. The generated `dist/` directory is ignored by Git.

### Source layout

- `src/commands/` — slash commands, each checked against the shared `Command` interface
- `src/events/` — ready handler and interaction dispatcher
- `src/interactions/` — slash-command execution and cooldown handling
- `src/buttons/` — button registry and feature-specific handlers
- `src/utils/` — message fetching, deduplication, grouping, and finalist selection
- `src/types.ts` — command, variant, session, and Discord client collection types
- `src/vendor/` — declarations for the untyped media downloader dependency
- `test/` — offline tests against the compiled output (no Discord login required)

### Adding buttons

Define handlers in a feature module under `src/buttons/`, keyed by exact Discord `customId` values:

```typescript
import type { ButtonHandler } from '../types.js';

export const exampleButtons = {
  'example:hello': async interaction => {
    await interaction.reply('Hello!');
  },
} satisfies Record<string, ButtonHandler>;
```

Import the group into `src/buttons/index.ts` and spread it into the registry alongside `shuffleButtons`. Each custom ID must be unique. No changes to `src/events/interaction-create.ts` are needed. Shuffle handlers share session lookup and selection rendering within their own module.

### Other commands

- `/archive` posts a formatted note to the thread configured by `ARCHIVE_NOTES_THREAD_ID` in `src/utils/constants.ts`.
- `/dw` downloads supported social-media videos; YouTube is excluded.
- `/yok` generates a random percentage rating.

Enable the Message Content privileged intent in the Discord developer portal. The bot also needs permission to read message history, create/send to threads, send polls, attach files, and manage nicknames as appropriate. Discord role hierarchy still limits which nicknames it can change.