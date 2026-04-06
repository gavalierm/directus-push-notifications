# Directus Batch Push Notifications

Custom Directus 11+ operation extension that sends batched Web Push notifications. Designed to run as a scheduled Flow — queries recent changes in configurable collections, groups them by band, respects per-band and per-subscriber notification preferences, and delivers push notifications via the Web Push protocol.

## Features

- **Batched notifications** — aggregates changes over a configurable interval (default 15 min) into a single notification per subscriber
- **Per-band preferences** — bands can enable/disable push for songs, setlists, albums individually
- **Per-subscriber preferences** — each subscriber can opt in/out per collection per band
- **Smart labeling** — distinguishes between newly created and updated items with Slovak labels
- **Auto-cleanup** — removes expired/invalid push subscriptions (410/404 responses)
- **VAPID authentication** — standard Web Push protocol with VAPID keys

## Requirements

- Directus 11+
- VAPID key pair (public + private)
- Collections: `push_subscriptions`, `push_subscription_bands`, `bands`, `songs`, `setlists`, `albums`
- A scheduled Directus Flow that triggers this operation

## Installation

### Option A: Git source (recommended for updates)

```bash
cd /path/to/directus/extensions/
git clone git@github.com:gavalierm/directus-push-notifications.git directus-operation-send-push
```

Restart Directus to load the extension.

**To update:**

```bash
cd /path/to/directus/extensions/directus-operation-send-push
git pull
```

Restart Directus.

### Option B: Manual copy

1. Copy `dist/api.js`, `dist/app.js`, and `package.json` to `extensions/directus-operation-send-push/`
2. Restart Directus

### Option C: Docker

```dockerfile
FROM directus/directus:latest

USER root
RUN corepack enable
USER node

RUN mkdir -p /directus/extensions/directus-operation-send-push
COPY dist/api.js /directus/extensions/directus-operation-send-push/
COPY dist/app.js /directus/extensions/directus-operation-send-push/
COPY package.json /directus/extensions/directus-operation-send-push/
```

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VAPID_PUBLIC_KEY` | Yes | VAPID public key for Web Push authentication |
| `VAPID_PRIVATE_KEY` | Yes | VAPID private key for Web Push authentication |
| `VAPID_SUBJECT` | Yes | VAPID subject (email or URL, e.g. `mailto:admin@yourapp.com`) |

### Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

### Example `.env`

```env
VAPID_PUBLIC_KEY=BEl62iUYgU...
VAPID_PRIVATE_KEY=xKZKYm1B...
VAPID_SUBJECT=mailto:admin@yourapp.com
```

## Directus Setup

### 1. Create `push_subscriptions` collection

Stores Web Push subscription data from browsers.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | integer (PK, auto) | Yes | — |
| `endpoint` | string (text) | Yes | Push service endpoint URL |
| `keys_p256dh` | string | Yes | Browser public key |
| `keys_auth` | string | Yes | Browser auth secret |
| `user` | uuid (FK → directus_users) | No | Subscribed user |
| `date_created` | timestamp (system) | No | When subscribed |

### 2. Create `push_subscription_bands` collection

Junction table: which bands a subscription is subscribed to, with per-collection preferences.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | integer (PK, auto) | Yes | — | — |
| `subscription` | integer (FK → push_subscriptions) | Yes | — | On delete: CASCADE |
| `band` | integer (FK → bands) | Yes | — | On delete: CASCADE |
| `notify_songs` | boolean | No | `true` | Receive notifications for song changes |
| `notify_setlists` | boolean | No | `true` | Receive notifications for setlist changes |
| `notify_albums` | boolean | No | `true` | Receive notifications for album changes |

### 3. Add push preference fields to `bands` collection

Add these fields to your existing `bands` collection:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `push_songs` | boolean | `true` | Enable push notifications for song changes |
| `push_setlists` | boolean | `true` | Enable push notifications for setlist changes |
| `push_albums` | boolean | `true` | Enable push notifications for album changes |

### 4. Required fields on content collections

The operation queries `songs`, `setlists`, and `albums` collections. Each must have:

| Field | Description |
|-------|-------------|
| `band` | FK to `bands` (integer) |
| `date_created` | Timestamp (system field) |
| `date_updated` | Timestamp (system field) |

### 5. Create a scheduled Flow

In Directus Admin → Settings → Flows:

1. **Create new Flow**
   - Name: `Push: Batch notifications`
   - Trigger: **Schedule**
   - Cron: `*/15 * * * *` (every 15 minutes)
   - Status: Active

2. **Add operation**
   - Type: **Batch Push Notifications** (appears after extension is installed)
   - No configuration needed — the operation reads env variables directly

## How It Works

```
Every 15 minutes (cron trigger):

1. Query songs, setlists, albums changed in last 15 min
2. Group changes by band
3. Filter by band-level preferences (push_songs, push_setlists, push_albums)
4. For each band, load subscribers from push_subscription_bands
5. Filter by subscriber preferences (notify_songs, notify_setlists, notify_albums)
6. Build notification body: "1 nová pieseň · 2 setlisty aktualizované"
7. Send Web Push to each subscriber
8. Clean up expired subscriptions (410/404)
```

### Notification format

```json
{
  "title": "Band Name",
  "body": "1 nová pieseň · 2 setlisty aktualizované",
  "url": "/notifications",
  "icon": "/img/fav/android-chrome-192x192.png",
  "badge": "/img/fav/favicon-32x32.png"
}
```

### Change detection

The operation distinguishes between **newly created** and **updated** items by comparing `date_created` and `date_updated`. If the difference is less than 5 seconds, the item is considered newly created.

| Slovak label (singular) | Plural | Type |
|------------------------|--------|------|
| nová pieseň | nové piesne | song created |
| pieseň aktualizovaná | piesne aktualizované | song updated |
| nový setlist | nové setlisty | setlist created |
| setlist aktualizovaný | setlisty aktualizované | setlist updated |
| nový album | nové albumy | album created |
| album aktualizovaný | albumy aktualizované | album updated |

## Frontend Integration

Your frontend app needs to:

1. **Request push permission** from the browser
2. **Subscribe** via `PushManager.subscribe()` with the VAPID public key
3. **Store subscription** — `POST /items/push_subscriptions` with endpoint, keys_p256dh, keys_auth
4. **Link to bands** — `POST /items/push_subscription_bands` with subscription ID and band ID
5. **Handle notifications** in a Service Worker (`push` event → `showNotification()`)

## Development

```bash
npm install
npx directus-extension build
```

Watch mode:

```bash
npx directus-extension build --watch
```

## License

MIT
