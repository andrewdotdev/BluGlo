# BluGo

A Fortnite STW taxibot manager with a real-time web dashboard and interactive CLI.

## Installation

```bash
npm install
```

## Run

```bash
npm start
```

This starts:

- Dashboard: `http://localhost:3000`
- Interactive CLI in the same terminal

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

You can use just the first 8 characters of an `accountId` in CLI commands.

## Configuration

`config.json` is organized into clear sections:

- `bot.status`
- `bot.party`
- `bot.features`
- `bot.auth`
- `bot.timings`
- `bot.reconnect`
- `dashboard`
- `dataFile`

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
