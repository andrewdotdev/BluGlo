# BluGlo

> [!WARNING]
> Development of this project has been discontinued as it's considered feature-complete and no further updates are planned
>
> This repository will remain open to pull requests, fixes, and community contributions. While the existing solutions may still work with modern versions of Fortnite, compatibility isn't guaranteed

## Installation

```bash
bun install
```

## Run

```bash
bun start
```

## CLI commands

| Command                                            | Description                  |
| -------------------------------------------------- | ---------------------------- |
| `/add [authorizationCode]`                         | Add and start a new bot      |
| `/add:device_auth <accountId> <deviceId> <secret>` | Add and start a bot manually |
| `/remove <accountId>`                              | Stop and remove a bot        |
| `/reload <accountId>`                              | Reconnect one bot            |
| `/reload all`                                      | Reconnect all bots           |
| `/list`                                            | List bots and current states |
| `/stats`                                           | Show bot statistics          |
| `/help`                                            | Show help                    |
| `/exit`                                            | Stop everything and exit     |

The first 8 characters of an `accountId` can be used in CLI commands

## Configuration

`config.json` is organized into clear sections

### Auth flow used by `/add`

1. Open Epic login using the authorization-code client.
2. Exchange the authorization code for a PC access token.
3. Request an exchange code.
4. Exchange that code for the final device-auth client token.
5. Create `deviceAuth` credentials.
6. Save `{ accountId, deviceId, secret }` and start the bot.

## Documentation

- fnbr docs: https://fnbr.js.org
- fnbr repository: https://github.com/fnbrjs/fnbr.js
- EpicResearch repository: https://github.com/MixV2/EpicResearch
- EpicResearch auth clients: https://github.com/MixV2/EpicResearch/blob/master/docs/auth/auth_clients.md
- EpicResearch authorization code flow: https://github.com/MixV2/EpicResearch/blob/master/docs/auth/grant_types/authorization_code.md
- EpicResearch exchange code flow: https://github.com/MixV2/EpicResearch/blob/master/docs/auth/grant_types/exchange_code.md
