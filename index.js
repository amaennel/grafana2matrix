require('dotenv').config();
const express = require('express');
const fs = require('fs');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || 'https://matrix.org';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID;
const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;

console.log(MATRIX_ACCESS_TOKEN, MATRIX_ROOM_ID, GRAFANA_URL ? 'Grafana URL Set' : 'No Grafana URL');

// In-memory store for active alerts (fingerprints) -> Alert Object
const activeAlerts = new Map();
// Map Matrix Event ID -> Alert ID (fingerprint)
const messageAlertMap = new Map();
let nextBatch = null;

// Track last summary times for severities
const lastSummaryTimes = {
    CRIT: Date.now(),
    WARN: Date.now()
};

app.use(express.json());

// Helper to generate a unique ID for an alert if fingerprint is missing
function getAlertId(alert) {
    if (alert.fingerprint) return alert.fingerprint;
    // Fallback: Hash the labels
    const labelString = Object.entries(alert.labels || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    return crypto.createHash('md5').update(labelString).digest('hex');
}

const sendMatrixNotification = async (messageContent) => {
    if (!MATRIX_ACCESS_TOKEN || !MATRIX_ROOM_ID) {
        console.error('Missing Matrix config, cannot send notification');
        return null;
    }
    const txnId = new Date().getTime() + '_' + Math.random().toString(36).substr(2, 9);
    const url = `${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(MATRIX_ROOM_ID)}/send/m.room.message/${txnId}`;

    try {
        const response = await fetch(url, {
            method: 'PUT',
            body: JSON.stringify({
                body: messageContent,
                format: "org.matrix.custom.html",
                formatted_body: messageContent
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                    .replace(/## (.*?)(\n|<br>)/, '<h3>$1</h3>')
                    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>'),
                msgtype: "m.text"
            }),
            headers: {
                'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.event_id;
    } catch (error) {
        console.error('Failed to send Matrix notification:', error.message);
        return null;
    }
};

async function createGrafanaSilence(alertId, matrixEventId) {
    const alert = activeAlerts.get(alertId);
    if (!alert) {
        console.error('Alert not found for silence:', alertId);
        return;
    }

    if (!GRAFANA_URL || !GRAFANA_API_KEY) {
        console.error('Grafana config missing, cannot silence');
        return;
    }

    const matchers = Object.entries(alert.labels).map(([name, value]) => ({
        name,
        value,
        isRegex: false,
        isEqual: true
    }));

    const now = new Date();
    const endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h

    const payload = {
        matchers,
        startsAt: now.toISOString(),
        endsAt: endsAt.toISOString(),
        createdBy: "MatrixBot",
        comment: `Silenced via Matrix for 24h`
    };

    try {
        const response = await fetch(`${GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Authorization': `Bearer ${GRAFANA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Grafana response:', errorData);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log(`Alert ${alertId} silenced successfully.`);
        await sendMatrixNotification(`🔇 Alert silenced for 24h: ${alert.labels.alertname}`);

        if (matrixEventId) {
            const reactionTxnId = new Date().getTime() + '_react_' + Math.random().toString(36).substr(2, 9);
            try {
                const reactRes = await fetch(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(MATRIX_ROOM_ID)}/send/m.reaction/${reactionTxnId}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        "m.relates_to": {
                            "rel_type": "m.annotation",
                            "event_id": matrixEventId,
                            "key": "☑️"
                        }
                    }),
                    headers: {
                        'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (!reactRes.ok) {
                    throw new Error(`HTTP error! status: ${reactRes.status}`);
                }
            } catch (reactErr) {
                console.error('Failed to send confirmation reaction:', reactErr.message);
            }
        }
    } catch (error) {
        console.error('Failed to create silence:', error.message);
    }
}

async function startMatrixSync() {
    if (!MATRIX_ACCESS_TOKEN) return;

    // Get initial next_batch
    try {
        if (!nextBatch) {
             const res = await fetch(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/sync?timeout=0`, {
                headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const data = await res.json();
            nextBatch = data.next_batch;
        }
    } catch (e) {
        console.error("Initial sync failed", e.message);
    }

    const loop = async () => {
        try {
            const url = `${MATRIX_HOMESERVER_URL}/_matrix/client/v3/sync?timeout=30000&since=${nextBatch || ''}`;
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const data = await res.json();
            
            nextBatch = data.next_batch;
            
            // Process events
            const rooms = data.rooms?.join || {};
            if (rooms[MATRIX_ROOM_ID]) {
                 const timeline = rooms[MATRIX_ROOM_ID].timeline?.events || [];
                 for (const event of timeline) {
                     if (event.type === 'm.reaction') {
                         const relatesTo = event.content?.['m.relates_to'];
                         if (relatesTo && relatesTo.rel_type === 'm.annotation') {
                             const key = relatesTo.key; // The emoji
                             const targetEventId = relatesTo.event_id;
                             
                             if (key === '🔇' || key === ':mute:') {
                                 if (messageAlertMap.has(targetEventId)) {
                                     const alertId = messageAlertMap.get(targetEventId);
                                     console.log(`Received mute reaction for event ${targetEventId}, alert ${alertId}`);
                                     await createGrafanaSilence(alertId, targetEventId);
                                 }
                             }
                         }
                     }
                 }
            }

        } catch (error) {
            console.error('Sync error:', error.message);
            await new Promise(r => setTimeout(r, 5000)); // Backoff
        }
        setImmediate(loop);
    };
    
    loop();
}

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        
        console.log('Received webhook:', JSON.stringify(data, null, 2));

        if (!MATRIX_ACCESS_TOKEN || !MATRIX_ROOM_ID) {
            console.error('MATRIX_ACCESS_TOKEN or MATRIX_ROOM_ID is not defined in environment variables');
            return res.status(500).send('Server configuration error');
        }

        // Handle Grafana Unified Alerting (Prometheus style)
        if (data.alerts && Array.isArray(data.alerts)) {
            const ruleUrl = data.externalURL;
            const alertsToNotify = [];

            // Filter and Deduplicate
            for (const alert of data.alerts) {
                const id = getAlertId(alert);
                const alertStatus = alert.status; // 'firing' or 'resolved'

                if (alertStatus === 'firing') {
                    if (!activeAlerts.has(id)) {
                        alertsToNotify.push(alert);
                        alert.mentionsSent = { primary: false, secondary: false };
                    } else {
                        const existing = activeAlerts.get(id);
                        alert.mentionsSent = existing.mentionsSent || { primary: false, secondary: false };
                    }
                    // Always update/add the alert to map to keep latest state
                    activeAlerts.set(id, alert);
                } else if (alertStatus === 'resolved') {
                    if (activeAlerts.has(id)) {
                        activeAlerts.delete(id);
                        alertsToNotify.push(alert);
                    } else {
                        alertsToNotify.push(alert);
                    }
                }
            }

            if (alertsToNotify.length === 0) {
                console.log('No state changes detected (all alerts are duplicates). Skipping individual Matrix notification.');
                return res.status(200).send('Processed');
            }

            // Send separate message for each alert
            const mentionConfig = getMentionConfig();
            for (const a of alertsToNotify) {
                const alertName = a.labels?.alertname || 'Unknown Alert';
                const host = a.labels?.host || a.labels?.instance || 'Unknown Host';
                const summary = a.annotations?.summary || '';
                const description = a.annotations?.description || a.annotations?.message || '';
                const severity = (a.labels?.severity || '').toUpperCase();
                
                const isFiring = a.status === 'firing';
                const icon = isFiring ? '🚨' : '✅';
                const statusDisplay = isFiring ? 'Firing' : 'Resolved';
                
                let matrixMessage = `## ${icon} ${statusDisplay}: ${alertName} (${host})\n`;
                
                if (summary) {
                    matrixMessage += `${summary}\n`;
                }
                
                if (description) {
                    matrixMessage += `${description}\n`;
                }

                // Check for immediate mentions
                if (isFiring && mentionConfig[host]) {
                    const config = mentionConfig[host];
                    let immediateMentions = [];

                    const checkImmediate = (type) => {
                        const delayCrit = config[`delay_crit_${type}`];
                        const delayWarn = config[`delay_warn_${type}`];

                        if (severity === 'CRITICAL' || severity === 'CRIT') {
                            return delayCrit === 0;
                        } else if (severity === 'WARNING' || severity === 'WARN') {
                            return delayWarn === 0;
                        }
                        return false;
                    };

                    // Check all applicable types
                    if (checkImmediate('secondary')) {
                         immediateMentions.push(...config['secondary']);
                    } 
                    if (checkImmediate('primary')) {
                         immediateMentions.push(...config['primary']);
                    }
                    
                    // Deduplicate
                    immediateMentions = [...new Set(immediateMentions)];

                    if (immediateMentions.length > 0) {
                        matrixMessage += `\nAttention: ${immediateMentions.join(' ')}\n`;
                    }
                }

                const links = [];
                if (ruleUrl) {
                    links.push(`[View in Grafana](${ruleUrl})`);
                }
                
                if (links.length > 0) {
                    matrixMessage += links.join(' | ');
                }

                const sentEventId = await sendMatrixNotification(matrixMessage);
                if (sentEventId && isFiring) {
                     const id = getAlertId(a);
                     messageAlertMap.set(sentEventId, id);
                }
            }

        } 
        // Handle Legacy Grafana Alerting (No deduplication logic applied here as it's singular)
        else {
            const status = data.state;
            const title = data.title || 'Grafana Alert';
            const messageBody = data.message || 'No message provided';
            const ruleUrl = data.ruleUrl;

            const isAlerting = status === 'firing' || status === 'alerting';
            const icon = isAlerting ? '🚨' : '✅';
            const statusDisplay = isAlerting ? 'Firing' : 'Resolved';

            const matrixMessage = `## ${icon} ${statusDisplay}: ${title}\n\n` +
                                  `${messageBody}\n\n` +
                                  (ruleUrl ? `[View in Grafana](${ruleUrl})` : '');

            await sendMatrixNotification(matrixMessage);
        }
        
        console.log('Notification(s) sent to Matrix');
        res.status(200).send('Notification sent');

    } catch (error) {
        console.error('Error processing webhook:', error.message);
        res.status(500).send('Error processing webhook');
    }
});

async function listJoinedRooms() {
    if (!MATRIX_ACCESS_TOKEN) {
        console.warn('Cannot list rooms: MATRIX_ACCESS_TOKEN is missing.');
        return;
    }

    console.log('Fetching joined rooms...');
    try {
        const res = await fetch(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/joined_rooms`, {
            headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
        });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();

        const rooms = data.joined_rooms || [];
        console.log(`Joined to ${rooms.length} rooms:`);

        for (const roomId of rooms) {
            let name = '';
            try {
                const nameRes = await fetch(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                    headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
                });
                if (nameRes.ok) {
                    const nameData = await nameRes.json();
                    name = nameData.name;
                }
            } catch (err) {
                // Ignore errors fetching name (e.g. 404 if not set)
            }
            console.log(`- ${roomId}${name ? ` (${name})` : ''}`);
        }
    } catch (error) {
        console.error('Failed to fetch joined rooms:', error.message);
    }
}

// Helper to get mention config
const getMentionConfig = () => {
    const configPath = process.env.MENTION_CONFIG_PATH;
    if (!configPath) return {};
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading mention config:', e.message);
    }
    return {};
};

// Periodic Summary Logic
const checkSummaries = async () => {
    const now = Date.now();
    const CRIT_INTERVAL = parseInt(process.env.SUMMARY_INTERVAL_CRIT_MS) || 2 * 60 * 60 * 1000; // Default 2 hours
    const WARN_INTERVAL = parseInt(process.env.SUMMARY_INTERVAL_WARN_MS) || 4 * 60 * 60 * 1000; // Default 4 hours

    const mentionConfig = getMentionConfig();

    // Check for alerts that need mentions
    const alertsNeedingMention = [];
    for (const [id, alert] of activeAlerts.entries()) {
        const host = alert.labels?.host || alert.labels?.instance;
        if (!host || !mentionConfig[host]) continue;

        const config = mentionConfig[host];
        const severity = (alert.labels?.severity || '').toUpperCase();
        const startsAt = new Date(alert.startsAt).getTime();
        const durationMinutes = (now - startsAt) / (1000 * 60);

        const checkMention = (type) => {
            const delayCrit = config[`delay_crit_${type}`];
            const delayWarn = config[`delay_warn_${type}`];

            if (severity === 'CRITICAL' || severity === 'CRIT') {
                return delayCrit >= 0 && durationMinutes >= delayCrit;
            } else if (severity === 'WARNING' || severity === 'WARN') {
                return delayWarn >= 0 && durationMinutes >= delayWarn;
            }
            return false;
        };

        let usersToMention = [];
        if (checkMention('secondary')) {
            usersToMention.push(...config['secondary']);
        }
        if (checkMention('primary')) {
            usersToMention.push(...config['primary']);
        }

        // Deduplicate
        usersToMention = [...new Set(usersToMention)];

        if (usersToMention.length > 0) {
            alertsNeedingMention.push({ id, alert, users: usersToMention.sort() });
        }
    }

    if (alertsNeedingMention.length > 0) {
        // Group by users to minimize messages
        const groups = {};
        for (const item of alertsNeedingMention) {
            const key = item.users.join(',');
            if (!groups[key]) groups[key] = { users: item.users, alerts: [] };
            groups[key].alerts.push(item);
        }

        for (const key in groups) {
            const group = groups[key];
            let msg = `## ⚠️ Persistent Alert Notification\n\n`;
            msg += `The following alerts have been active for a significant time:\n\n`;
            for (const item of group.alerts) {
                const alertName = item.alert.labels?.alertname || 'Unknown Alert';
                const host = item.alert.labels?.host || item.alert.labels?.instance || 'Unknown Host';
                msg += `- **${alertName}** on **${host}**\n`;
            }
            msg += `\nAttention: ${group.users.join(' ')}`;
            await sendMatrixNotification(msg);
        }
    }

    const sendSummary = async (severity) => {
        const alertsForSeverity = [];
        for (const alert of activeAlerts.values()) {
            const sev = alert.labels?.severity || 'UNKNOWN';
            if (sev === severity) {
                alertsForSeverity.push(alert);
            }
        }

        if (alertsForSeverity.length > 0) {
            console.log(`Sending summary for severity: ${severity}`);
            
            // Group by host
            const alertsByHost = {};
            for (const alert of alertsForSeverity) {
                const host = alert.labels?.host || alert.labels?.instance || 'Unknown Host';
                if (!alertsByHost[host]) {
                    alertsByHost[host] = [];
                }
                alertsByHost[host].push(alert);
            }

            const sortedHosts = Object.keys(alertsByHost).sort();
            let summaryMessage = `## 📋 ${severity} Alert Summary\n\n`;
            
            for (const host of sortedHosts) {
                summaryMessage += `**Host: ${host}**\n`;
                for (const alert of alertsByHost[host]) {
                    const alertName = alert.labels?.alertname || 'Unknown Alert';
                    const summary = alert.annotations?.summary || alert.annotations?.description || '';
                    summaryMessage += `- ${alertName}${summary ? `: ${summary}` : ''}\n`;
                }
                summaryMessage += `\n`;
            }

            await sendMatrixNotification(summaryMessage);
        }
    };

    if (now - lastSummaryTimes.CRIT >= CRIT_INTERVAL) {
        await sendSummary('CRIT');
        lastSummaryTimes.CRIT = now;
    }

    if (now - lastSummaryTimes.WARN >= WARN_INTERVAL) {
        await sendSummary('WARN');
        lastSummaryTimes.WARN = now;
    }
};

// Check every minute
setInterval(checkSummaries, 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    listJoinedRooms();
    startMatrixSync();
});
