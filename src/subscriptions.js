import { config } from './config.js';
import {
    addSubscription,
    deleteBotState,
    deleteSubscription,
    deleteSubscriptionsForRoom,
    getAllActiveAlerts,
    getAllSubscriptions,
    getBotState,
    getSubscriptionsForRoom,
    setBotState,
    setMessageMap,
} from './db.js';
import { createMatrixMessage } from './messages.js';
import { getAlertValue, getMentionConfig } from './util.js';

const MAX_SUBSCRIPTIONS_PER_ROOM = 100;
const MAX_PATTERN_LENGTH = 255;
const MEMBER_CACHE_TTL = 60 * 1000;
const PRIVATE_CHAT_NAME = 'Alert subscriptions';
const PRIVATE_CHAT_TOPIC = 'Grafana alerts for the hosts you subscribe to. Send .help for commands.';
const ALERT_ROOM_COMMANDS = ['.subscribe', '.unsubscribe', '.subscriptions'];

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

const listItems = (items) => items.map((item) => `- ${item}`).join('\n');

// Adds subscriptions for a room and returns the confirmation message
const subscribeHosts = (roomId, hosts, userId) => {
    const existing = getSubscriptionsForRoom(roomId).map((s) => s.host);
    const added = [];
    const rejected = [];
    for (const host of hosts) {
        if (host.length > MAX_PATTERN_LENGTH) {
            rejected.push(`${host.slice(0, 20)}... (too long)`);
            continue;
        }
        if (!existing.includes(host) && existing.length + added.length >= MAX_SUBSCRIPTIONS_PER_ROOM) {
            rejected.push(`${host} (limit of ${MAX_SUBSCRIPTIONS_PER_ROOM} subscriptions reached)`);
            continue;
        }
        addSubscription(roomId, host, userId);
        if (!existing.includes(host)) added.push(host);
    }
    let msg = added.length > 0 ? `✅ Subscribed to:\n${listItems(added)}` : '';
    if (rejected.length > 0) {
        msg += `${msg ? '\n\n' : ''}⛔️ Not subscribed:\n${listItems(rejected)}`;
    }
    return msg || 'Already subscribed to these hosts.';
};

const privateChatKey = (userId) => `private_chat:${userId}`;

// The user's private chat, as long as both the bot and the user are (or are invited) in it
const getExistingPrivateChat = async (matrix, userId) => {
    const roomId = getBotState(privateChatKey(userId));
    if (!roomId) return null;
    const membership = await matrix.getMembership(roomId, userId);
    if (membership === 'join' || membership === 'invite') return roomId;
    deleteBotState(privateChatKey(userId));
    return null;
};

// Reuses or creates an unencrypted private chat with the user.
// Returns { roomId, created } or { error } with error being 'encrypted' or 'failed'.
const openPrivateChat = async (matrix, userId) => {
    const existing = await getExistingPrivateChat(matrix, userId);
    if (existing) return { roomId: existing, created: false };

    const roomId = await matrix.createPrivateChat(userId, PRIVATE_CHAT_NAME, PRIVATE_CHAT_TOPIC);
    if (!roomId) return { error: 'failed' };

    if ((await matrix.isRoomEncrypted(roomId)) === true) {
        // The homeserver enforces encryption for new rooms, so the bot cannot offer a usable chat
        console.error(`Homeserver enabled encryption for new room ${roomId}, abandoning it.`);
        await matrix.kickUser(roomId, userId, 'Room was created encrypted, which the bot does not support');
        await matrix.leaveRoom(roomId);
        return { error: 'encrypted' };
    }

    setBotState(privateChatKey(userId), roomId);
    await reply(matrix, roomId, HELP_MESSAGE);
    return { roomId, created: true };
};

const privateChatErrorMessage = (error) =>
    error === 'encrypted'
        ? 'The homeserver enforces encryption for new rooms, which I do not support, so I cannot open a private chat.'
        : 'Sorry, I could not create a private chat. Please try again later.';

// .subscribe etc. in the alert room: open the private chat with the sender
const handleAlertRoomCommand = async (matrix, event) => {
    const [command, ...args] = event.content.body.trim().split(/\s+/);
    if (!ALERT_ROOM_COMMANDS.includes(command)) return;

    await matrix.sendReaction(event.event_id, '☑️');
    const user = event.sender;

    if (!(await isAllowedUser(matrix, user))) {
        await reply(matrix, matrix.roomID, `${user}: you are not allowed to use host subscriptions.`);
        return;
    }

    if (command !== '.subscribe') {
        await reply(
            matrix,
            matrix.roomID,
            `${user}: subscriptions are managed in your private chat with me. Send .subscribe here to open it.`
        );
        return;
    }

    const chat = await openPrivateChat(matrix, user);
    if (chat.error) {
        await reply(matrix, matrix.roomID, `${user}: ${privateChatErrorMessage(chat.error)}`);
        return;
    }

    if (args.length > 0) {
        await reply(matrix, chat.roomId, subscribeHosts(chat.roomId, args, user));
    }

    const location = chat.created
        ? `I've invited you to a private chat ("${PRIVATE_CHAT_NAME}")`
        : 'Your private chat with me is already open';
    const next = args.length > 0 ? 'Your subscriptions are listed there.' : 'Send .subscribe <host> there to subscribe.';
    await reply(matrix, matrix.roomID, `${user}: ${location}. ${next}`);
};

// Encrypted rooms already dealt with. The encryption event of a room can show up again in the
// timeline after joining it, which must not trigger a second warning or private chat.
const handledEncryptedRooms = new Set();

// The bot cannot read encrypted rooms: move the user to an unencrypted private chat and leave
const handleEncryptedRoom = async (matrix, roomId, userId) => {
    if (handledEncryptedRooms.has(roomId)) return;
    handledEncryptedRooms.add(roomId);

    if (userId && getBotState(privateChatKey(userId)) === roomId) {
        deleteBotState(privateChatKey(userId));
    }

    const subs = getSubscriptionsForRoom(roomId);
    const chat = userId ? await openPrivateChat(matrix, userId) : { error: 'failed' };
    let msg = '⚠️ This room is end-to-end encrypted. I do not support encryption, so I cannot read messages here.';

    if (chat.error) {
        msg += `\n${privateChatErrorMessage(chat.error)}`;
        if (subs.length > 0) {
            msg += '\nI will keep sending alerts for your subscriptions to this room, but cannot read commands.';
            await reply(matrix, roomId, msg);
            return;
        }
        await reply(matrix, roomId, msg);
        await matrix.leaveRoom(roomId);
        return;
    }

    for (const sub of subs) {
        addSubscription(chat.roomId, sub.host, sub.userId);
    }
    deleteSubscriptionsForRoom(roomId);

    msg += chat.created
        ? `\nI've invited you to an unencrypted private chat ("${PRIVATE_CHAT_NAME}") instead.`
        : `\nPlease use your existing private chat with me ("${PRIVATE_CHAT_NAME}") instead.`;
    if (subs.length > 0) {
        msg += ' Your subscriptions have been moved there.';
        await reply(matrix, chat.roomId, `Moved your subscriptions from the encrypted room:\n${listItems(subs.map((s) => s.host))}`);
    }
    await reply(matrix, roomId, msg);
    await matrix.leaveRoom(roomId);
};

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
            await reply(matrix, roomId, subscribeHosts(roomId, args, event.sender));
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
        if (!(await matrix.joinRoom(roomId))) return;

        if ((await matrix.isRoomEncrypted(roomId)) === true) {
            console.log(`Room ${roomId} is encrypted, offering an unencrypted private chat instead.`);
            await handleEncryptedRoom(matrix, roomId, inviter);
            return;
        }
        setBotState(privateChatKey(inviter), roomId);
        await reply(matrix, roomId, HELP_MESSAGE);
    });

    // Encryption was turned on in a private chat after the bot joined
    matrix.on('encryptionEnabled', async ({ roomId, sender }) => {
        if (roomId === matrix.roomID || sender === matrix.userId) return;
        console.log(`Encryption was enabled in ${roomId} by ${sender}.`);
        const user = (await isAllowedUser(matrix, sender)) ? sender : getSubscriptionsForRoom(roomId)[0]?.userId;
        await handleEncryptedRoom(matrix, roomId, user);
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
        if (!body || !body.startsWith('.')) {
            return;
        }
        if (event.room_id === matrix.roomID) {
            await handleAlertRoomCommand(matrix, event);
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
