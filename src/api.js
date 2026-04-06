import webPush from 'web-push';

const INTERVAL_MINUTES = 15;
const CREATE_THRESHOLD_SECONDS = 5;

const COLLECTIONS = ['songs', 'setlists', 'albums'];

const COLLECTION_LABELS = {
  songs: { create: 'nová pieseň', update: 'pieseň aktualizovaná', createPlural: 'nové piesne', updatePlural: 'piesne aktualizované' },
  setlists: { create: 'nový setlist', update: 'setlist aktualizovaný', createPlural: 'nové setlisty', updatePlural: 'setlisty aktualizované' },
  albums: { create: 'nový album', update: 'album aktualizovaný', createPlural: 'nové albumy', updatePlural: 'albumy aktualizované' },
};

/** Determine if a record is newly created or updated */
function isNewRecord(record) {
  if (!record.date_created || !record.date_updated) return false;
  const created = new Date(record.date_created).getTime();
  const updated = new Date(record.date_updated).getTime();
  return Math.abs(updated - created) < CREATE_THRESHOLD_SECONDS * 1000;
}

/**
 * Build notification body from grouped changes.
 * Format: "1 nový setlist · 2 piesne aktualizované"
 * Order: creates first, then updates.
 */
function buildNotificationBody(bandChanges) {
  const parts = [];

  // Collect creates first, then updates
  for (const phase of ['create', 'update']) {
    for (const collection of COLLECTIONS) {
      const items = bandChanges[collection];
      if (!items) continue;
      const count = items.filter(r => phase === 'create' ? isNewRecord(r) : !isNewRecord(r)).length;
      if (count === 0) continue;

      const labels = COLLECTION_LABELS[collection];
      const label = count === 1
        ? `${count} ${labels[phase]}`
        : `${count} ${labels[phase + 'Plural']}`;
      parts.push(label);
    }
  }

  return parts.join(' · ');
}

export default {
  id: 'send-push',
  handler: async (_opts, { database, logger, env }) => {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      logger.error('[batch-push] Missing VAPID environment variables');
      return { success: false, reason: 'missing_vapid_config' };
    }

    webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

    const cutoff = new Date(Date.now() - INTERVAL_MINUTES * 60 * 1000).toISOString();

    try {
      // 1. Query changed items per collection, grouped by band
      const bandChanges = {}; // { bandId: { songs: [...], setlists: [...], albums: [...] } }

      for (const collection of COLLECTIONS) {
        const rows = await database(collection)
          .where('date_updated', '>', cutoff)
          .whereNotNull('band')
          .select('id', 'band', 'date_created', 'date_updated');

        for (const row of rows) {
          if (!bandChanges[row.band]) bandChanges[row.band] = {};
          if (!bandChanges[row.band][collection]) bandChanges[row.band][collection] = [];
          bandChanges[row.band][collection].push(row);
        }
      }

      const bandIds = Object.keys(bandChanges).map(Number);
      if (!bandIds.length) {
        logger.info('[batch-push] No changes in last interval');
        return { success: true, sent: 0 };
      }

      // 2. Load band configs (title + push_* preferences)
      const bands = await database('bands')
        .whereIn('id', bandIds)
        .select('id', 'title', 'push_songs', 'push_setlists', 'push_albums');

      const bandMap = Object.fromEntries(bands.map(b => [b.id, b]));

      let totalSent = 0;
      let totalFailed = 0;
      const allExpired = [];

      for (const bandId of bandIds) {
        const band = bandMap[bandId];
        if (!band) continue;

        // 3. Filter collections by global band config
        const filtered = {};
        for (const col of COLLECTIONS) {
          const pushKey = `push_${col}`;
          if (band[pushKey] !== false && bandChanges[bandId][col]?.length) {
            filtered[col] = bandChanges[bandId][col];
          }
        }

        if (!Object.keys(filtered).length) continue;

        // 4. Load subscribers with preferences
        const subscribers = await database('push_subscription_bands')
          .join('push_subscriptions', 'push_subscription_bands.subscription', 'push_subscriptions.id')
          .where('push_subscription_bands.band', bandId)
          .select(
            'push_subscriptions.id',
            'push_subscriptions.endpoint',
            'push_subscriptions.keys_p256dh',
            'push_subscriptions.keys_auth',
            'push_subscription_bands.notify_songs',
            'push_subscription_bands.notify_setlists',
            'push_subscription_bands.notify_albums'
          );

        if (!subscribers.length) continue;

        // 5. Build per-subscriber payloads and send
        const sends = [];

        for (const sub of subscribers) {
          // Filter by subscriber preferences
          const subFiltered = {};
          for (const col of Object.keys(filtered)) {
            const notifyKey = `notify_${col}`;
            if (sub[notifyKey] !== false) {
              subFiltered[col] = filtered[col];
            }
          }

          if (!Object.keys(subFiltered).length) continue;

          const body = buildNotificationBody(subFiltered);
          if (!body) continue;

          const payload = JSON.stringify({
            title: band.title || 'Spevník',
            body,
            url: '/notifications',
            icon: '/img/fav/android-chrome-192x192.png',
            badge: '/img/fav/favicon-32x32.png',
          });

          sends.push(
            webPush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
              payload
            ).then(() => ({ status: 'sent', id: sub.id }))
            .catch(err => {
              if (err.statusCode === 410 || err.statusCode === 404) {
                return { status: 'expired', id: sub.id };
              }
              logger.error(`[batch-push] Failed for ${sub.endpoint}: ${err.message}`);
              return { status: 'failed', id: sub.id };
            })
          );
        }

        const results = await Promise.allSettled(sends);

        for (const r of results) {
          const val = r.status === 'fulfilled' ? r.value : r.reason;
          if (val?.status === 'sent') totalSent++;
          else if (val?.status === 'expired') allExpired.push(val.id);
          else totalFailed++;
        }
      }

      // 6. Cleanup expired subscriptions
      if (allExpired.length) {
        await database('push_subscription_bands').whereIn('subscription', allExpired).delete();
        await database('push_subscriptions').whereIn('id', allExpired).delete();
        logger.info(`[batch-push] Removed ${allExpired.length} expired subscriptions`);
      }

      logger.info(`[batch-push] Done: ${totalSent} sent, ${totalFailed} failed, ${allExpired.length} expired`);
      return { success: true, sent: totalSent, failed: totalFailed, expired: allExpired.length };
    } catch (error) {
      logger.error(`[batch-push] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  },
};
