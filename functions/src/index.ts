import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

initializeApp();

const DATABASE_ID = 'ai-studio-moonlightgangana-05cb7dee-3acf-45f2-a549-e0cfe08af03b';
const GROUP_ID = 'moonlight-gang';
const DHAKA_TIMEZONE = 'Asia/Dhaka';

const db = getFirestore(DATABASE_ID);
const webhookSecret = defineSecret('MOONLIGHT_WEBHOOK_SECRET');

const dhakaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DHAKA_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function sanitizeId(raw: string, fallbackPrefix: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  return cleaned || `${fallbackPrefix}_${Date.now().toString(36)}`;
}

export const ingestMoonlightMessage = onRequest(
  { secrets: [webhookSecret], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const providedSignature = req.header('x-moonlight-signature');
    if (!providedSignature || providedSignature !== webhookSecret.value()) {
      res.status(401).json({ error: 'Unauthorized webhook signature' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const rawMessageId = String(body.messageId || '').trim();
    const rawSenderId = String(body.senderId || '').trim();
    const rawSenderName = String(body.senderDisplayName || '').trim();
    const rawTimestamp = String(body.timestamp || new Date().toISOString()).trim();

    if (!rawMessageId || !rawSenderId || !rawSenderName) {
      res.status(400).json({ error: 'messageId, senderId, and senderDisplayName are required' });
      return;
    }

    const parsedDate = new Date(rawTimestamp);
    if (Number.isNaN(parsedDate.getTime())) {
      res.status(400).json({ error: 'Invalid ISO timestamp' });
      return;
    }

    const messageId = sanitizeId(rawMessageId, 'msg');
    const senderId = sanitizeId(rawSenderId, 'mem');
    const senderDisplayName = rawSenderName.slice(0, 80);
    const isoTimestamp = parsedDate.toISOString();
    const dateKeyDhaka = dhakaDateFormatter.format(parsedDate);
    const monthKeyDhaka = dateKeyDhaka.slice(0, 7);

    const handle = typeof body.handle === 'string' ? body.handle.trim().slice(0, 80) : '';
    const avatarUrl =
      typeof body.avatarUrl === 'string' && body.avatarUrl.startsWith('https://')
        ? body.avatarUrl.trim().slice(0, 512)
        : '';

    try {
      const result = await db.runTransaction(async (tx) => {
        const msgRef = db.collection('messageEvents').doc(messageId);
        const existingMsg = await tx.get(msgRef);
        if (existingMsg.exists) {
          return { duplicate: true };
        }

        const groupRef = db.collection('groups').doc(GROUP_ID);
        const memberRef = db.collection('members').doc(senderId);
        const dailyRef = db.collection('dailyStatistics').doc(dateKeyDhaka);
        const monthlyRef = db.collection('monthlyStatistics').doc(monthKeyDhaka);
        const statusRef = db.collection('integrationStatus').doc(GROUP_ID);

        const [groupSnap, memberSnap, dailySnap, monthlySnap] = await Promise.all([
          tx.get(groupRef),
          tx.get(memberRef),
          tx.get(dailyRef),
          tx.get(monthlyRef),
        ]);

        const creationDate =
          (groupSnap.exists ? (groupSnap.data()?.creationDate as string) : dateKeyDhaka) ||
          dateKeyDhaka;
        const withinCreationWindow = dateKeyDhaka >= creationDate;

        // 1. Update or create member
        if (!memberSnap.exists) {
          tx.set(memberRef, {
            memberId: senderId,
            groupId: GROUP_ID,
            displayName: senderDisplayName,
            handle,
            avatarUrl,
            totalMessages: 1,
            lastActiveAt: isoTimestamp,
            lastActiveDateDhaka: dateKeyDhaka,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(memberRef, {
            displayName: senderDisplayName,
            totalMessages: FieldValue.increment(1),
            lastActiveAt: isoTimestamp,
            lastActiveDateDhaka: dateKeyDhaka,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        // 2. Update or create daily statistic
        const prevDailyTotal = dailySnap.exists ? Number(dailySnap.data()?.totalMessages || 0) : 0;
        const nextDailyTotal = prevDailyTotal + 1;
        if (!dailySnap.exists) {
          tx.set(dailyRef, {
            dateKey: dateKeyDhaka,
            groupId: GROUP_ID,
            monthKey: monthKeyDhaka,
            totalMessages: 1,
            activeMemberCount: 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(dailyRef, {
            totalMessages: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        // 3. Update or create monthly statistic
        if (!monthlySnap.exists) {
          tx.set(monthlyRef, {
            monthKey: monthKeyDhaka,
            groupId: GROUP_ID,
            totalMessages: 1,
            activeDays: 1,
            peakDailyMessages: 1,
            peakDate: dateKeyDhaka,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          const prevPeak = Number(monthlySnap.data()?.peakDailyMessages || 0);
          tx.update(monthlyRef, {
            totalMessages: FieldValue.increment(1),
            ...(prevDailyTotal === 0 ? { activeDays: FieldValue.increment(1) } : {}),
            ...(nextDailyTotal > prevPeak
              ? { peakDailyMessages: nextDailyTotal, peakDate: dateKeyDhaka }
              : {}),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        // 4. Update group totals
        if (groupSnap.exists) {
          const prevHighest = Number(groupSnap.data()?.highestDailyCount || 0);
          tx.update(groupRef, {
            ...(memberSnap.exists ? {} : { totalMembers: FieldValue.increment(1) }),
            ...(withinCreationWindow
              ? {
                  totalLifetimeMessages: FieldValue.increment(1),
                  ...(prevDailyTotal === 0 ? { totalActiveDays: FieldValue.increment(1) } : {}),
                  ...(nextDailyTotal > prevHighest
                    ? { highestDailyCount: nextDailyTotal, highestDailyDate: dateKeyDhaka }
                    : {}),
                }
              : {}),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: 'cloud_function_webhook',
          });
        }

        // 5. Write deduplicated metadata-only message event
        tx.set(msgRef, {
          messageId,
          groupId: GROUP_ID,
          senderId,
          senderDisplayName,
          timestamp: isoTimestamp,
          receivedTimestamp: FieldValue.serverTimestamp(),
          dateKeyDhaka,
          monthKeyDhaka,
          source: 'official_webhook',
          createdBy: 'cloud_function_webhook',
        });

        // 6. Update integration status heartbeat
        tx.set(
          statusRef,
          {
            groupId: GROUP_ID,
            status: 'connected',
            lastHeartbeatAt: new Date().toISOString(),
            lastEventAt: isoTimestamp,
            eventsProcessedCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: 'cloud_function_webhook',
          },
          { merge: true }
        );

        return { duplicate: false };
      });

      res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: result.duplicate,
        messageId,
        dateKeyDhaka,
      });
    } catch (error) {
      console.error('Webhook ingestion failed:', error);
      res.status(500).json({ error: 'Internal ingestion failure' });
    }
  }
);

export const autoDistributeDailyMessages = onSchedule(
  { schedule: '1 0 * * *', timeZone: DHAKA_TIMEZONE },
  async () => {
    const now = new Date();
    const todayDhaka = dhakaDateFormatter.format(now);
    const monthKeyDhaka = todayDhaka.slice(0, 7);
    const isoTimestamp = `${todayDhaka}T00:01:00+06:00`;

    const settingsRef = db.collection('adminSettings').doc(GROUP_ID);
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) return;

    const settings = settingsSnap.data() || {};
    if (settings.autoDistEnabled !== true) return;
    if (String(settings.autoDistLastRunDateDhaka || '') >= todayDhaka) return;

    const membersSnap = await db.collection('members').where('groupId', '==', GROUP_ID).get();
    if (membersSnap.empty) return;

    const allMembers = membersSnap.docs.map((d) => ({
      memberId: String(d.data().memberId || d.id),
      displayName: String(d.data().displayName || 'Member'),
    }));

    const minTotal = Math.max(1, Math.floor(Number(settings.autoDistMinTotal) || 20000));
    const maxTotal = Math.max(minTotal, Math.floor(Number(settings.autoDistMaxTotal) || 30000));
    const totalToAdd = minTotal + Math.floor(Math.random() * (maxTotal - minTotal + 1));
    const participantMode = settings.autoDistParticipantMode === 'subset' ? 'subset' : 'all';

    let participants = [...allMembers];
    if (participantMode === 'subset' && participants.length > 1) {
      for (let i = participants.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [participants[i], participants[j]] = [participants[j], participants[i]];
      }
      const minKeep = Math.max(2, Math.ceil(participants.length * 0.55));
      const keepCount = minKeep + Math.floor(Math.random() * (participants.length - minKeep + 1));
      participants = participants.slice(0, keepCount);
    }

    if (totalToAdd < participants.length) {
      participants = participants.slice(0, totalToAdd);
    }

    const weights = participants.map(() => 0.3 + Math.random() * 1.65);
    const weightSum = weights.reduce((s, w) => s + w, 0) || participants.length;
    const base = 1;
    const remaining = totalToAdd - base * participants.length;
    const exact = weights.map((w) => (remaining * w) / weightSum);
    const amounts = exact.map((v) => base + Math.floor(v));
    let leftover = totalToAdd - amounts.reduce((s, v) => s + v, 0);
    const remainders = exact
      .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < leftover; i += 1) {
      amounts[remainders[i % participants.length].idx] += 1;
    }

    await db.runTransaction(async (tx) => {
      const freshSettings = await tx.get(settingsRef);
      if (String(freshSettings.data()?.autoDistLastRunDateDhaka || '') >= todayDhaka) {
        return;
      }

      const groupRef = db.collection('groups').doc(GROUP_ID);
      const dailyRef = db.collection('dailyStatistics').doc(todayDhaka);
      const monthlyRef = db.collection('monthlyStatistics').doc(monthKeyDhaka);
      const statusRef = db.collection('integrationStatus').doc(GROUP_ID);

      const [groupSnap, dailySnap, monthlySnap] = await Promise.all([
        tx.get(groupRef),
        tx.get(dailyRef),
        tx.get(monthlyRef),
      ]);

      const msgSnaps = await Promise.all(
        participants.map((p) => {
          const msgId = sanitizeId(`autosc_${todayDhaka}_${p.memberId}`, 'msg');
          return tx.get(db.collection('messageEvents').doc(msgId));
        })
      );

      let actualAdded = 0;
      participants.forEach((p, idx) => {
        if (msgSnaps[idx].exists) return;
        const count = amounts[idx];
        actualAdded += count;
        const msgId = sanitizeId(`autosc_${todayDhaka}_${p.memberId}`, 'msg');
        tx.set(db.collection('messageEvents').doc(msgId), {
          messageId: msgId,
          groupId: GROUP_ID,
          senderId: p.memberId,
          senderDisplayName: p.displayName,
          timestamp: isoTimestamp,
          receivedTimestamp: FieldValue.serverTimestamp(),
          dateKeyDhaka: todayDhaka,
          monthKeyDhaka,
          source: 'admin_manual',
          createdBy: 'cloud_function_scheduler',
          ...(count > 1 ? { messageCount: count } : {}),
        });
        tx.update(db.collection('members').doc(p.memberId), {
          totalMessages: FieldValue.increment(count),
          lastActiveAt: isoTimestamp,
          lastActiveDateDhaka: todayDhaka,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      if (actualAdded > 0) {
        const prevDailyTotal = dailySnap.exists ? Number(dailySnap.data()?.totalMessages || 0) : 0;
        const nextDailyTotal = prevDailyTotal + actualAdded;
        if (!dailySnap.exists) {
          tx.set(dailyRef, {
            dateKey: todayDhaka,
            groupId: GROUP_ID,
            monthKey: monthKeyDhaka,
            totalMessages: actualAdded,
            activeMemberCount: participants.length,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(dailyRef, {
            totalMessages: FieldValue.increment(actualAdded),
            activeMemberCount: Math.max(
              Number(dailySnap.data()?.activeMemberCount || 0),
              participants.length
            ),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        if (!monthlySnap.exists) {
          tx.set(monthlyRef, {
            monthKey: monthKeyDhaka,
            groupId: GROUP_ID,
            totalMessages: actualAdded,
            activeDays: 1,
            peakDailyMessages: actualAdded,
            peakDate: todayDhaka,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          const prevPeak = Number(monthlySnap.data()?.peakDailyMessages || 0);
          tx.update(monthlyRef, {
            totalMessages: FieldValue.increment(actualAdded),
            ...(prevDailyTotal === 0 ? { activeDays: FieldValue.increment(1) } : {}),
            ...(nextDailyTotal > prevPeak
              ? { peakDailyMessages: nextDailyTotal, peakDate: todayDhaka }
              : {}),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        if (groupSnap.exists) {
          const creationDate = String(groupSnap.data()?.creationDate || todayDhaka);
          const prevHighest = Number(groupSnap.data()?.highestDailyCount || 0);
          if (todayDhaka >= creationDate) {
            tx.update(groupRef, {
              totalLifetimeMessages: FieldValue.increment(actualAdded),
              ...(prevDailyTotal === 0 ? { totalActiveDays: FieldValue.increment(1) } : {}),
              ...(nextDailyTotal > prevHighest
                ? { highestDailyCount: nextDailyTotal, highestDailyDate: todayDhaka }
                : {}),
              updatedAt: FieldValue.serverTimestamp(),
              updatedBy: 'cloud_function_scheduler',
            });
          }
        }

        tx.update(statusRef, {
          lastEventAt: isoTimestamp,
          eventsProcessedCount: FieldValue.increment(actualAdded),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'cloud_function_scheduler',
        });
      }

      tx.update(settingsRef, {
        autoDistLastRunDateDhaka: todayDhaka,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'cloud_function_scheduler',
      });
    });
  }
);

const dhakaTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DHAKA_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function getDhakaMinutesOfDayFn(date: Date): number {
  const parts = dhakaTimeFormatter.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

export const dripContinuousDailyMessages = onSchedule(
  { schedule: '*/5 * * * *', timeZone: DHAKA_TIMEZONE },
  async () => {
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString().slice(0, 40);
    const todayDhaka = dhakaDateFormatter.format(now);
    const monthKeyDhaka = todayDhaka.slice(0, 7);
    const minutesElapsed = getDhakaMinutesOfDayFn(now);

    const settingsRef = db.collection('adminSettings').doc(GROUP_ID);
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) return;

    const settings = settingsSnap.data() || {};
    if (settings.dripEnabled !== true) return;

    const membersSnap = await db.collection('members').where('groupId', '==', GROUP_ID).get();
    if (membersSnap.empty) return;

    const allMembers = membersSnap.docs.map((d) => ({
      memberId: String(d.data().memberId || d.id),
      displayName: String(d.data().displayName || 'Member'),
    }));

    await db.runTransaction(async (tx) => {
      const freshSettingsSnap = await tx.get(settingsRef);
      const freshSettings = freshSettingsSnap.data() || {};
      if (freshSettings.dripEnabled !== true) return;

      const intervalMinutes = Math.max(
        1,
        Math.min(60, Math.floor(Number(freshSettings.dripIntervalMinutes) || 4))
      );
      const minDailyTotal = Math.max(
        1,
        Math.floor(Number(freshSettings.dripMinDailyTotal) || 15000)
      );
      const lastTickIso = String(freshSettings.dripLastTickIso || '');
      const lastTickMs = lastTickIso ? Date.parse(lastTickIso) : 0;
      const lastDateDhaka = String(freshSettings.dripLastDateDhaka || '');

      const groupRef = db.collection('groups').doc(GROUP_ID);
      const dailyRef = db.collection('dailyStatistics').doc(todayDhaka);
      const monthlyRef = db.collection('monthlyStatistics').doc(monthKeyDhaka);
      const statusRef = db.collection('integrationStatus').doc(GROUP_ID);

      const [groupSnap, dailySnap, monthlySnap] = await Promise.all([
        tx.get(groupRef),
        tx.get(dailyRef),
        tx.get(monthlyRef),
      ]);

      const prevDailyTotal = dailySnap.exists ? Number(dailySnap.data()?.totalMessages || 0) : 0;
      const endOfDayUrgent = minutesElapsed >= 1385 && prevDailyTotal < minDailyTotal;
      const minWaitMs = endOfDayUrgent ? 60_000 : intervalMinutes * 60_000;
      if (
        lastDateDhaka === todayDhaka &&
        Number.isFinite(lastTickMs) &&
        lastTickMs > 0 &&
        nowMs - lastTickMs < minWaitMs
      ) {
        return;
      }

      const effectiveDailyTarget = Math.round(minDailyTotal * 1.12);
      const dayProgress = Math.min(1, (minutesElapsed + 1) / 1440);
      const expectedByNow = Math.floor(effectiveDailyTarget * dayProgress);
      const paceDeficit = expectedByNow - prevDailyTotal;
      const endOfDayDeficit =
        minutesElapsed >= 1380 && prevDailyTotal < minDailyTotal
          ? minDailyTotal - prevDailyTotal + 50 + Math.floor(Math.random() * 250)
          : 0;
      const isCatchup = endOfDayDeficit > 0 || paceDeficit > 300;

      const shuffled = [...allMembers];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const allocations: Array<{ memberId: string; displayName: string; count: number; timestamp: string }> = [];
      if (isCatchup) {
        const catchupTotal = Math.max(endOfDayDeficit, paceDeficit);
        const maxRecipients = Math.min(shuffled.length, 12, Math.max(1, catchupTotal));
        const chosen = shuffled.slice(0, maxRecipients);
        const weights = chosen.map(() => 0.35 + Math.random() * 1.65);
        const weightSum = weights.reduce((s, w) => s + w, 0) || chosen.length;
        const remaining = Math.max(0, catchupTotal - chosen.length);
        const exact = weights.map((w) => (remaining * w) / weightSum);
        const amounts = exact.map((v) => 1 + Math.floor(v));
        const leftover = catchupTotal - amounts.reduce((s, v) => s + v, 0);
        const remIdx = exact
          .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
          .sort((a, b) => b.frac - a.frac);
        for (let i = 0; i < leftover; i += 1) {
          amounts[remIdx[i % chosen.length].idx] += 1;
        }
        chosen.forEach((m, idx) => {
          allocations.push({
            memberId: m.memberId,
            displayName: m.displayName,
            count: amounts[idx],
            timestamp: nowIso,
          });
        });
      } else {
        const pickCount = Math.min(shuffled.length, 1 + Math.floor(Math.random() * 3));
        const chosen = shuffled.slice(0, pickCount);
        chosen.forEach((m) => {
          allocations.push({
            memberId: m.memberId,
            displayName: m.displayName,
            count: 20 + Math.floor(Math.random() * 31),
            timestamp: nowIso,
          });
        });
      }

      const totalAdded = allocations.reduce((s, a) => s + a.count, 0);
      if (totalAdded <= 0) return;

      const batchStamp = nowMs.toString(36);
      allocations.forEach((item, idx) => {
        const msgId = sanitizeId(`drip_${todayDhaka}_${batchStamp}_${idx}`, 'msg');
        tx.set(db.collection('messageEvents').doc(msgId), {
          messageId: msgId,
          groupId: GROUP_ID,
          senderId: item.memberId,
          senderDisplayName: item.displayName,
          timestamp: item.timestamp,
          receivedTimestamp: FieldValue.serverTimestamp(),
          dateKeyDhaka: todayDhaka,
          monthKeyDhaka,
          source: 'admin_manual',
          createdBy: 'cloud_function_scheduler',
          ...(item.count > 1 ? { messageCount: item.count } : {}),
        });
        tx.update(db.collection('members').doc(item.memberId), {
          totalMessages: FieldValue.increment(item.count),
          lastActiveAt: item.timestamp,
          lastActiveDateDhaka: todayDhaka,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const nextDailyTotal = prevDailyTotal + totalAdded;
      if (!dailySnap.exists) {
        tx.set(dailyRef, {
          dateKey: todayDhaka,
          groupId: GROUP_ID,
          monthKey: monthKeyDhaka,
          totalMessages: nextDailyTotal,
          activeMemberCount: allocations.length,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(dailyRef, {
          totalMessages: FieldValue.increment(totalAdded),
          activeMemberCount: Math.max(
            Number(dailySnap.data()?.activeMemberCount || 0),
            allocations.length
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (!monthlySnap.exists) {
        tx.set(monthlyRef, {
          monthKey: monthKeyDhaka,
          groupId: GROUP_ID,
          totalMessages: totalAdded,
          activeDays: 1,
          peakDailyMessages: nextDailyTotal,
          peakDate: todayDhaka,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const prevPeak = Number(monthlySnap.data()?.peakDailyMessages || 0);
        tx.update(monthlyRef, {
          totalMessages: FieldValue.increment(totalAdded),
          ...(prevDailyTotal === 0 ? { activeDays: FieldValue.increment(1) } : {}),
          ...(nextDailyTotal > prevPeak
            ? { peakDailyMessages: nextDailyTotal, peakDate: todayDhaka }
            : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (groupSnap.exists) {
        const creationDate = String(groupSnap.data()?.creationDate || todayDhaka);
        const prevHighest = Number(groupSnap.data()?.highestDailyCount || 0);
        if (todayDhaka >= creationDate) {
          tx.update(groupRef, {
            totalLifetimeMessages: FieldValue.increment(totalAdded),
            ...(prevDailyTotal === 0 ? { totalActiveDays: FieldValue.increment(1) } : {}),
            ...(nextDailyTotal > prevHighest
              ? { highestDailyCount: nextDailyTotal, highestDailyDate: todayDhaka }
              : {}),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: 'cloud_function_scheduler',
          });
        }
      }

      tx.update(statusRef, {
        lastEventAt: nowIso,
        eventsProcessedCount: FieldValue.increment(totalAdded),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'cloud_function_scheduler',
      });

      tx.update(settingsRef, {
        dripLastTickIso: nowIso,
        dripLastDateDhaka: todayDhaka,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'cloud_function_scheduler',
      });
    });
  }
);

