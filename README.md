# node-red-contrib-slack-modern [![npm](https://img.shields.io/npm/v/node-red-contrib-slack-modern.svg)](https://www.npmjs.com/package/node-red-contrib-slack-modern) [<img height="20px" src="https://nodered.org/about/resources/media/node-red-hexagon.png">](https://flows.nodered.org/node/node-red-contrib-slack-modern)

Slack nodes for Node-RED built for **modern Slack apps**. Events arrive over [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), so no public URL is needed, and any [Web API](https://docs.slack.dev/reference/methods) method can be called.

Classic Slack apps and the RTM API they rely on are being phased out. This package replaces RTM based nodes such as `slack-rtm-in` while keeping the same message shape, so existing flows keep working.

![Example flow in the Node-RED editor](https://raw.githubusercontent.com/FilipChalupa/node-red-contrib-slack-modern/main/docs/screenshot.png)

## Nodes

| Node           | Purpose                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| **slack app**  | Config node with the bot token (`xoxb-…`) and app token (`xapp-…`), stored as credentials, not in flow exports. |
| **slack in**   | Emits Slack events. `msg.payload` is the complete event (`ts`, `thread_ts`, `files`, `blocks`, …) plus `userObject` and `channelObject`. Optionally filters by event type, channel (`#ops` or ID), message kind (new, outside threads, thread replies) and drops the app's own messages. |
| **slack api**  | Calls any Web API method: `msg.topic` is the method, `msg.payload` its arguments, the response comes out as `msg.payload`. |
| **slack file** | Downloads a private file (`files[].url_private` in `msg.url`) using the bot token. Outputs a buffer.         |

### Example usage ([JSON export](./examples/basic.json))

Reply in a thread to every message (with **Ignore events caused by this app** enabled in `slack in`):

```
[slack in] → [change: topic = chat.postMessage, payload = {channel, thread_ts: payload.ts, text}] → [slack api]
```

## Slack app setup

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (or reuse one) and paste the manifest below in **App Manifest**, adjusting it to your needs.
2. **Basic Information → App-Level Tokens**: generate a token with the `connections:write` scope. That is the **app token** (`xapp-…`).
3. **Install App**: install to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to the channels it should listen to (`/invite @your-app`).

```yaml
display_information:
  name: Node-RED
features:
  bot_user:
    display_name: Node-RED
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history # messages in public channels
      - groups:history # messages in private channels
      - im:history # direct messages
      - mpim:history # group direct messages
      - channels:read # channelObject for public channels
      - groups:read # channelObject for private channels
      - users:read # userObject
      - chat:write # chat.postMessage
      - chat:write.customize # custom username and icon_emoji
      - reactions:write # reactions.add / reactions.remove
      - files:read # slack file node
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

> [!IMPORTANT]
> Slack spreads events across **all** Socket Mode connections of one app. Do not connect another Socket Mode client (a second Node-RED, a Bolt app, …) with the same app token, otherwise some events will only reach the other client.

## Migrating from node-red-contrib-slack

| node-red-contrib-slack | node-red-contrib-slack-modern | Notes                                                                                   |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `slack-config`         | `slack app`                   | Bot token of the modern app plus a new app token.                                       |
| `slack-rtm-in`         | `slack in`                    | Same `msg.payload` including `userObject` and `channelObject`. `msg.slackState` is gone. |
| `slack-web-out`        | `slack api`                   | Same contract, `msg.topic` + `msg.payload`.                                             |
| `http request` with `Authorization: Bearer xoxb-…` | `slack file` | No token pasted into the flow.                                           |
| `slack-rtm-out`        | `slack api` with `chat.postMessage` | RTM sending does not exist for modern apps.                                       |
| `slack-state`          | `slack api` with `users.list`, `conversations.list`, … |                                                                |

> [!WARNING]
> Messages posted by a modern app do not always carry `subtype: "bot_message"`. Enable **Ignore events caused by this app** in `slack in` so the app does not react to its own replies, or filter other bots by checking that `msg.payload.bot_id` is missing.

## Development

```sh
npm install
npm run dev # tsc --watch
npm test
```

## Releasing

Releases are staged on npm by [GitHub Actions](./.github/workflows/publish.yml) using [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in the repository.

One-time setup:

```sh
npm trust github node-red-contrib-slack-modern --repo FilipChalupa/node-red-contrib-slack-modern --file publish.yml --env npm --allow-stage-publish
```

Release:

```sh
npm version minor # bumps package.json and creates the v* tag
git push --follow-tags
# after the workflow finishes:
npm stage list node-red-contrib-slack-modern
npm stage approve <stage-id> # asks for 2FA
```
