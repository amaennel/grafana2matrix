# Grafana to Matrix Webhook Adapter

This project is a bridge between Grafana Alerting and Matrix. It receives webhook notifications from Grafana, formats them, and forwards them to a specified Matrix room. It also supports advanced features like interactive silencing via Matrix reactions, configurable user mentions, and periodic alert summaries.

## Features

- **Grafana Webhook Support:** Handles webhooks from Grafana Unified Alerting (and legacy format).
- **Matrix Notifications:** Sends formatted HTML messages to a Matrix room with alert details (status, name, host, summary, links).
- **Alert Deduplication:** Tracks active alerts to minimize noise, only notifying on state changes or new firings.
- **Smart Mentions:**
  - Configurable mentions based on the alert's `host` label.
  - Supports different mention policies for `CRIT` and `WARN` severities.
  - Can delay mentions (e.g., only mention if active for X minutes) or mention immediately.
- **Interactive Silencing:**
  - React to an alert message in Matrix with 🔇 (or `:mute:`) to silence the alert in Grafana for 24 hours.
  - The bot confirms the silence with a ☑️ reaction and a message.
- **Periodic Summaries:**
  - Sends a digest of active alerts at specific scheduled times defined in UTC.
  - Helps keep track of long-running issues.
  - By default even summaries without active alerts are sent. This can be disabled to reduce messages.
- **Private Host Subscriptions:**
  - Open a private chat with the bot and subscribe to individual hosts (wildcards supported).
  - The private chat receives the same firing/resolved notifications as the channel, but only for the subscribed hosts.
- **Persistence:** All internal state is stored in a SQLiteDB, allowing for restarts without a flood of messages during startup.

## Prerequisites

- Node.js (v22.5+)
- A Matrix account (bot user)
- A Grafana instance (for alerts and silencing API)

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

You can configure the application using environment variables (via a `.env` file) or a JSON configuration file.

### JSON Configuration

By default, the application looks for a `config.json` file in the working directory. You can specify a custom config file using the `--config` argument:

```bash
npm start -- --config /path/to/my-config.json
```

or 

```bash
node src/index.js --config /path/to/my-config.json
```

### Environment Variables / Config Keys

Create a `.env` file in the root directory or use a JSON file with the following keys:

```env
# Server Configuration
PORT=3000

# Matrix Configuration
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your_matrix_access_token
MATRIX_ROOM_ID=!your_room_id:matrix.org
KEEP_ALIVE_INTERVAL=60            # update interval for the status message, set to 0 to disable
ADDITIONAL_LABELS=label1,label2,annotation3 #optional
SUBSCRIPTION_ALLOWED_USERS=@user1:matrix.org,@user2:matrix.org #optional, see "Private Host Subscriptions"

# Grafana Configuration (Required for Silencing)
GRAFANA_URL=https://your-grafana-instance.com
GRAFANA_API_KEY=your_grafana_api_key

# Mention Feature
MENTION_CONFIG_PATH=./mention-config.json
SUMMARY_SCHEDULE_CRIT=08:00,16:00  # UTC times
SUMMARY_SCHEDULE_WARN=08:00        # UTC times
SUMMARY_SCHEDULE_SKIP_EMPTY=false  # default (set to true to skip scheduled summaries without active alerts)

# Storage
DB_FILE=alerts.db
```

Note that the room id is not the public name of a channel. 
To aid with the discovery of the correct room ID, the bot prints all rooms it has access to at startup.

### Mention Configuration (`mention-config.json`)

If you use `MENTION_CONFIG_PATH`, create a JSON file (e.g., `mention-config.json`) with the following structure:

```json
{
  "host-01": { // key needs to **exactly** match host label value
    "primary": ["@user1:matrix.org"],
    "secondary": ["@user2:matrix.org"],
    "private": ["@user3:matrix.org"], // receive all alerts of this host in a private chat (optional)
    "delay_crit_primary": 0,    // 0 = Immediate
    "delay_warn_primary": 30,   // Mention after 30 mins
    "delay_crit_secondary": 60,
    "delay_warn_secondary": -1, // -1 = Never mention
    "repeat_crit_primary": 60,  // Repeat every 60m. null (default)=Every grafana summary, -1=Once
    "repeat_warn_primary": -1   // Mention once, do not repeat
  }
}
```

This mention config is reloaded when an alert fires and can therefore be updated while the bot runs.

Users listed under `private` get every alert of that host in a private chat with the bot, without subscribing themselves
(see [Private Host Subscriptions](#private-host-subscriptions)).

## Running the Project

Start the bot:

```bash
npm start
```

On startup, the bot will log a list of joined rooms to the console, which helps you find the `MATRIX_ROOM_ID` if you don't have it.

## Docker

The application can be run as a container. Images are automatically built and published via GitHub Actions.

### Docker CLI

You can run the container directly, passing configuration via environment variables:

```bash
docker run -d \
  --name grafana-to-matrix \
  -p 3000:3000 \
  -v ./config/:/app/config/ \
  -e MATRIX_ACCESS_TOKEN=your_token \
  -e MATRIX_ROOM_ID=!your_room_id:matrix.org \
  -e DB_FILE=/app/config/alerts.db \
  ghcr.io/amaennel/grafana2matrix:latest
```

### Docker Compose

Alternatively, use `docker-compose.yml` for a more persistent setup:

```yaml
services:
  grafana-to-matrix:
    image: ghcr.io/amaennel/grafana2matrix:latest
    container_name: grafana-to-matrix
    ports:
      - "3000:3000"
    volumes:
      # Mount a directory for the bot to store its state in
      - ./config/:/app/config/

      # Mount a config.json file, if you have one, to the project root
      #- ./config.json:/app/config.json

      # Mount the mention config if created
      # - ./mention-config.json:/app/mention-config.json:ro
    environment:
      - MATRIX_HOMESERVER_URL=https://matrix.org
      - MATRIX_ACCESS_TOKEN=your_token
      - MATRIX_ROOM_ID=!your_room_id:matrix.org
      - GRAFANA_URL=https://your-grafana-instance.com
      - GRAFANA_API_KEY=your_grafana_api_key

      # Point the bot to the mounted config directory (see above)
      - DB_FILE=/app/config/alerts.db
    restart: unless-stopped
```

Run it with:
```bash
docker-compose up -d
```

## Usage

1. **Configure Grafana:**
   - In Grafana Alerting -> Contact Points, add a new contact point of type **Webhook**.
   - Set the URL to `http://your-bot-host:3000/webhook`.
2. **Receive Alerts:**
   - When an alert fires, you will see a message in the Matrix room.
3. **Silence Alerts:**
   - React to the alert message with the 🔇 emoji.
   - The bot will call the Grafana API to create a silence and confirm in the chat.

## Chat Commands

The bot supports the following commands in the Matrix room:

- **`.summary <severity>`**: Manually triggers an alert summary for the specified severity.
  - Example: `.summary CRITICAL` or `.summary WARNING`
- **`.silences <severity>`**: Shows actively firing alerts that are currently suppressed by a silence. Takes the severity to filter by as an optional argument.
- **`.reload-config`**: Reloads the configuration from disk (both `.env` and `config.json`) without restarting the process. Useful for updating mention configurations or schedules on the fly.



## Private Host Subscriptions

Instead of (or in addition to) watching the alert channel, you can get alerts for specific hosts in a private chat with the bot:

1. Send `.subscribe` (optionally followed by hosts, e.g. `.subscribe web-*`) in the alert room.
   The bot creates an unencrypted private chat ("Alert subscriptions") and invites you. Running it again reuses that chat.
   Alternatively, invite the bot to a room yourself; it joins automatically and posts a help message.
2. Subscribe to the hosts you care about in the private chat:
   - **`.subscribe <host> [<host> ...]`**: Subscribe to one or more hosts. `*` works as a wildcard, e.g. `.subscribe web-* db01`.
   - **`.unsubscribe <host> [<host> ...]`**: Remove subscriptions (use the exact pattern you subscribed with).
   - **`.subscriptions`**: List the current subscriptions of this chat.
   - **`.hosts`**: List known hosts (hosts with active alerts and hosts from the mention config).
   - **`.help`**: Show the help message.

The host is matched against the `host` label (or `instance`, if there is no `host` label), just like in the channel message.
Every firing and resolved notification sent to the channel for a subscribed host is also sent to the private chat (without mentions).
Reacting with 🔇 to an alert in the private chat silences it, just like in the channel; the confirmation is posted in both rooms.

**Configured private alerts:** Hosts in the mention config can list users under `private`.
On the first alert for such a host, the bot opens a private chat with each listed user (if there is none yet) and from then on sends that host's alerts there.
These hosts show up in `.subscriptions` and cannot be removed with `.unsubscribe`.
Since the mention config is maintained by the administrator, these users do not need to be members of the alert room.
If a user rejects the invite or leaves a chat the bot opened on its own, the bot does not invite them again until they send `.subscribe` in the alert room or invite the bot themselves.

**Access control:** By default only users that are members of the alert room (`MATRIX_ROOM_ID`) can use subscriptions, since they can already see all alerts.
Invites from other users are rejected, and subscribers who leave the alert room stop receiving alerts.
Set `SUBSCRIPTION_ALLOWED_USERS` to a comma-separated list of Matrix user IDs to use an explicit allowlist instead.

When everyone else leaves the private chat, the bot leaves as well and deletes its subscriptions.

**Encryption:** The bot does not support end-to-end encryption, and Element encrypts new direct messages by default.
If you invite the bot to an encrypted room, it posts a notice, invites you to an unencrypted private chat instead and leaves.
If encryption is turned on in a private chat later, the bot moves its subscriptions to a new unencrypted chat in the same way.
In chats created by the bot only the bot may turn on encryption.
If your homeserver enforces encryption for all new rooms (e.g. Synapse's `encryption_enabled_by_default_for_room_type`), private chats cannot be used.

## Alert Labels

To take full advantage of the bot's features, your Grafana alerts should include the following labels:

- `host` or `instance`: Used to identify the affected system. The `host` label is specifically used for matching entries in `mention-config.json`.
- `severity`: Used for smart mentions and periodic summaries. The bot looks for `CRIT`/`CRITICAL` or `WARN`/`WARNING` (case-insensitive).

Annotations like `summary`, `description`, or `message` are also supported and will be included in the Matrix notification body if present.
You can specify additional labels and annotations which should be shown in Matrix notifications using the option `ADDITIONAL_LABELS`.

Note that Grafana sends only the labels that were used during the alert query. In case of a `severity` label,
this should be added as an annotation to the alert (point 5 in the grafana alert UI).