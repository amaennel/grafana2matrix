import { config } from './config.js';
import {
    addSubscription,
    deleteSubscription,
    deleteSubscriptionsForRoom,
    getAllActiveAlerts,
    getAllSubscriptions,
    getSubscriptionsForRoom,
    setMessageMap,
} from './db.js';
import { createMatrixMessage } from './messages.js';
import { getAlertValue, getMentionConfig } from './util.js';

const MAX_SUBSCRIPTIONS_PER_ROOM = 100;
const MAX_PATTERN_LENGTH = 255;
const MEMBER_CACHE_TTL = 60 * 1000;

const HELP_MESSAGE =
    `## 🔔 Host Subscriptions\n` +
    `In this private chat you receive the same alert notifications as the alert channel, ` +
    `but only for the hosts you subscribe to.\n\n` +
    `**Commands**\n` +
    `- .subscribe <host> [<host> ...]: subscribe to hosts (use * as wildcard, e.g. web-*)\n` +
    `- .unsubscribe <host> [<host> ...]: remove subscriptions\n` +
    `- .subscriptions: list your subscriptions\n` +
    `- .hosts: list known hosts\n` +
    `- .help: show this message\n\n` +
    `React with 🔇 to an alert to silence it in Grafana for 24h.`;

const getAlertHost = (alert) => getAlertValue(alert, 'host') ?? getAlertValue(alert, 'instance') ?? 'Unknown Host';

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hostMatchesPattern = (host, pattern) => {
    if (!pattern.includes('*')) return host === pattern;
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(host);
};

let memberCache = { roomId: null, members: null, fetchedAt: 0 };

// Members of the alert room may use subscriptions, unless an explicit allowlist is configured.
const isAllowedUser = async (matrix, userId) => {
    if (!userId) return false;

    if (config.SUBSCRIPTION_ALLOWED_USERS) {
        const allowed = config.SUBSCRIPTION_ALLOWED_USERS.split(',').map((u) => u.trim());
        return allowed.includes(userId);
    }

    const now = Date.now();
    if (memberCache.roomId !== matrix.roomID || now - memberCache.fetchedAt > MEMBER_CACHE_TTL) {
        const members = await matrix.getJoinedMembers(matrix.roomID);
        if (members) {
            memberCache = { roomId: matrix.roomID, members: new Set(members), fetchedAt: now };
        } else if (memberCache.roomId !== matrix.roomID) {
            // No usable (stale) data for this room: fail closed
            return false;
        }
    }

    return memberCache.members.has(userId);
};

const reply = (matrix, roomId, message) => matrix.sendMatrixNotification(message, roomId);

const handleCommand = async (matrix, event) => {
    const roomId = event.room_id;
    const body = event.content.body.trim();
    const [command, ...args] = body.split(/\s+/);

    switch (command) {
        case '.subscribe': {
            if (args.length === 0) {
                await reply(matrix, roomId, 'Usage: .subscribe <host> [<host> ...]');
                return;
            }
            const existing = getSubscriptionsForRoom(roomId).map((s) => s.host);
            const added = [];
            const rejected = [];
            for (const host of args) {
                if (host.length > MAX_PATTERN_LENGTH) {
                    rejected.push(`${host.slice(0, 20)}... (too long)`);
                    continue;
                }
                if (!existing.includes(host) && existing.length + added.length >= MAX_SUBSCRIPTIONS_PER_ROOM) {
                    rejected.push(`${host} (limit of ${MAX_SUBSCRIPTIONS_PER_ROOM} subscriptions reached)`);
                    continue;
                }
                addSubscription(roomId, host, event.sender);
                if (!existing.includes(host)) added.push(host);
            }
            let msg = added.length > 0 ? `✅ Subscribed to:\n${added.map((h) => `- ${h}`).join('\n')}` : '';
            if (rejected.length > 0) {
                msg += `${msg ? '\n\n' : ''}⛔️ Not subscribed:\n${rejected.map((h) => `- ${h}`).join('\n')}`;
            }
            await reply(matrix, roomId, msg || 'Already subscribed to these hosts.');
            break;
        }
        case '.unsubscribe': {
            if (args.length === 0) {
                await reply(matrix, roomId, 'Usage: .unsubscribe <host> [<host> ...]');
                return;
            }
            const removed = args.filter((host) => deleteSubscription(roomId, host));
            const notFound = args.filter((host) => !removed.includes(host));
            let msg = removed.length > 0 ? `✅ Unsubscribed from:\n${removed.map((h) => `- ${h}`).join('\n')}` : '';
            if (notFound.length > 0) {
                msg += `${msg ? '\n\n' : ''}Not subscribed to:\n${notFound.map((h) => `- ${h}`).join('\n')}`;
            }
            await reply(matrix, roomId, msg);
            break;
        }
        case '.subscriptions': {
            const subs = getSubscriptionsForRoom(roomId);
            if (subs.length === 0) {
                await reply(matrix, roomId, 'No subscriptions yet. Use .subscribe <host> to add one.');
            } else {
                await reply(matrix, roomId, `## 🔔 Subscriptions\n${subs.map((s) => `- ${s.host}`).join('\n')}`);
            }
            break;
        }
        case '.hosts': {
            const activeHosts = new Set(getAllActiveAlerts().map(getAlertHost));
            const hosts = [...new Set([...activeHosts, ...Object.keys(getMentionConfig())])].sort();
            const subs = getSubscriptionsForRoom(roomId).map((s) => s.host);
            if (hosts.length === 0) {
                await reply(matrix, roomId, 'No known hosts (no active alerts).');
                return;
            }
            const lines = hosts.map((host) => {
                const subscribed = subs.some((pattern) => hostMatchesPattern(host, pattern));
                const alerting = activeHosts.has(host);
                return `- ${host}${alerting ? ' 🚨' : ''}${subscribed ? ' (subscribed)' : ''}`;
            });
            await reply(matrix, roomId, `## 🖥️ Known Hosts\n🚨 = currently alerting\n\n${lines.join('\n')}`);
            break;
        }
        case '.help':
            await reply(matrix, roomId, HELP_MESSAGE);
            break;
        default:
            return;
    }
    await matrix.sendReaction(event.event_id, '☑️', roomId);
};

// Leave a private chat once the bot is the only member left and forget its subscriptions
const leaveIfEmpty = async (matrix, roomId) => {
    const members = await matrix.getJoinedMembers(roomId);
    if (members && members.filter((m) => m !== matrix.userId).length === 0) {
        console.log(`All users left room ${roomId}, leaving and removing subscriptions.`);
        deleteSubscriptionsForRoom(roomId);
        await matrix.leaveRoom(roomId);
    }
};

const setupSubscriptions = (matrix) => {
    matrix.on('invite', async ({ roomId, inviter }) => {
        if (roomId === matrix.roomID) {
            await matrix.joinRoom(roomId);
            return;
        }
        if (!(await isAllowedUser(matrix, inviter))) {
            console.log(`Rejecting invite to ${roomId} from ${inviter}: not allowed to use subscriptions.`);
            await matrix.leaveRoom(roomId);
            return;
        }
        console.log(`Accepting invite to ${roomId} from ${inviter}.`);
        if (await matrix.joinRoom(roomId)) {
            await reply(matrix, roomId, HELP_MESSAGE);
        }
    });

    matrix.on('leave', ({ roomId }) => {
        console.log(`Bot left room ${roomId}, removing its subscriptions.`);
        deleteSubscriptionsForRoom(roomId);
    });

    matrix.on('memberChange', async ({ roomId, membership }) => {
        if (roomId !== matrix.roomID && (membership === 'leave' || membership === 'ban')) {
            await leaveIfEmpty(matrix, roomId);
        }
    });

    matrix.on('userMessage', async (event) => {
        const body = event.content?.body;
        if (!body || event.room_id === matrix.roomID || !body.startsWith('.')) {
            return;
        }
        if (!(await isAllowedUser(matrix, event.sender))) {
            console.log(`Ignoring command from ${event.sender} in ${event.room_id}: not allowed.`);
            return;
        }
        await handleCommand(matrix, event);
    });
};

// Rooms (other than the alert room) that subscribed to the host of the alert
const getSubscribedRooms = async (matrix, alert) => {
    const host = getAlertHost(alert);
    const rooms = new Set();

    for (const sub of getAllSubscriptions()) {
        if (sub.roomId === matrix.roomID || rooms.has(sub.roomId)) continue;
        if (!hostMatchesPattern(host, sub.host)) continue;
        // Re-check on delivery so users who left the alert room stop receiving alerts
        if (await isAllowedUser(matrix, sub.userId)) {
            rooms.add(sub.roomId);
        }
    }
    return rooms;
};

const notifySubscribers = async (matrix, alert) => {
    const rooms = await getSubscribedRooms(matrix, alert);
    if (rooms.size === 0) return;

    const message = createMatrixMessage(alert, { mentions: false });
    for (const roomId of rooms) {
        const eventId = await matrix.sendMatrixNotification(message, roomId);
        if (eventId && alert.status === 'firing') {
            setMessageMap(eventId, alert.fingerprint);
        }
    }
};

export { setupSubscriptions, notifySubscribers, isAllowedUser };
