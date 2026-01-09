import dotenv from 'dotenv'
import express from 'express';
import { MatrixServer } from './matrix.js';
import { createMatrixMessage } from './messages.js';
import { isCritical, isWarn, getMentionConfig } from './util.js';

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || 'https://matrix.org';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID;
const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;
const SUMMARY_SCHEDULE_CRIT = process.env.SUMMARY_SCHEDULE_CRIT;
const SUMMARY_SCHEDULE_WARN = process.env.SUMMARY_SCHEDULE_WARN;

// In-memory store for active alerts (fingerprints) -> Alert Object
const activeAlerts = new Map();
// Map Matrix Event ID -> Alert ID (fingerprint)
const messageAlertMap = new Map();
let nextBatch = null;

// Track last sent schedule times (UTC minutes from midnight)
const lastSentSchedule = {
    CRIT: -1,
    WARN: -1
};

if (!MATRIX_ACCESS_TOKEN || !MATRIX_ROOM_ID || !MATRIX_HOMESERVER_URL) {
    throw new Error("MATRIX_ACCESS_TOKEN or MATRIX_ROOM_ID or MATRIX_HOMESERVER_URL is not defined in environment variables");
}


const matrix = new MatrixServer(MATRIX_HOMESERVER_URL, MATRIX_ROOM_ID, MATRIX_ACCESS_TOKEN);

const sendSummary = async (severity) => {
    const alertsForSeverity = [];
    for (const alert of activeAlerts.values()) {
        const sev = (alert.annotations?.severity || 'UNKNOWN').toUpperCase();
        let matches = false;
        
        if (isCritical(severity)) {
            matches = isCritical(sev);
        } else if (isWarn(severity)) {
            matches = isWarn(sev);
        } else {
            matches = (sev === severity);
        }

        if (matches) {
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

        await matrix.sendMatrixNotification(summaryMessage);
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
        createdBy: "Grafana2Matrix",
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
        
        await matrix.sendMatrixNotification(`🔇 Alert silenced for 24h: ${alert.annotations.severity} ${alert.labels.host} ${alert.labels.alertname}`);

        if (matrixEventId) {
            matrix.sendReaction(matrixEventId);
        }
    } catch (error) {
        console.error('Failed to create silence:', error.message);
    }
}

matrix.on("reaction", async (reaction) => {
    const {key, targetEventId} = reaction;

    if (key === '🔇' || key === ':mute:') {
        if (messageAlertMap.has(targetEventId)) {
            const alertId = messageAlertMap.get(targetEventId);
            console.log(`Received mute reaction for event ${targetEventId}, alert ${alertId}`);
            await createGrafanaSilence(alertId, targetEventId);
        }
    }
})

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        
        console.log('Received webhook:', JSON.stringify(data, null, 2));


        // Handle Grafana Unified Alerting (Prometheus style)
        if (data.alerts && Array.isArray(data.alerts)) {
            const ruleUrl = data.externalURL;
            const alertsToNotify = [];

            // Filter and Deduplicate
            for (const alert of data.alerts) {
                const id = alert.fingerprint;
                const alertStatus = alert.status; // 'firing' or 'resolved'

                if (alertStatus === 'firing') {
                    if (!activeAlerts.has(id)) {
                        console.log(`New firing alert: ${id} (${alert.labels?.alertname})`);
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
                        console.log(`Alert resolved: ${id} (${alert.labels?.alertname})`);
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
               
                const matrixMessage = createMatrixMessage(a);

                const sentEventId = await matrix.sendMatrixNotification(matrixMessage);
                if (sentEventId && a.status === 'firing') {
                     const id = a.fingerprint;
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

            await matrix.sendMatrixNotification(matrixMessage);
        }
        
        console.log('Notification(s) sent to Matrix');
        res.status(200).send('Notification sent');

    } catch (error) {
        console.error('Error processing webhook:', error.message);
        res.status(500).send('Error processing webhook');
    }
});

// Periodic Summary Logic
const checkSummariesAndMentions = async () => {
    const now = Date.now();

    // Check for alerts that need mentions
    const mentionConfig = getMentionConfig();

    const alertsNeedingMention = [];
    for (const [id, alert] of activeAlerts.entries()) {
        const host = alert.labels?.host || alert.labels?.instance;
        if (!host || !mentionConfig[host]) continue;

        const config = mentionConfig[host];
        const severity = (alert.labels?.severity  ||  alert.annotations?.severity || '').toUpperCase();
        const startsAt = new Date(alert.startsAt).getTime();
        const durationMinutes = (now - startsAt) / (1000 * 60);

        const checkMention = (type) => {
            const delayCrit = config[`delay_crit_${type}`];
            const delayWarn = config[`delay_warn_${type}`];

            if (isCritical(severity)) {
                return delayCrit >= 0 && durationMinutes >= delayCrit;
            } else if (isWarn(severity)) {
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
            msg += `\nAttention: ${group.users.map(v => `@${v}`).join(' ')}`;
            await matrix.sendMatrixNotification(msg);
        }
    }

    const nowUtc = new Date();
    // Calculate minutes from midnight (0-1439)
    const currentMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
    
    // Helper to parse HH:mm to minutes
    const parseTimeToMinutes = (timeStr) => {
        if (!timeStr) return -1;
        const [hours, minutes] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(minutes)) return -1;
        return hours * 60 + minutes;
    };

    const checkSchedule = async (severity, scheduleStr) => {
        if (!scheduleStr) return;
        
        // Parse all scheduled times
        const scheduledMinutes = scheduleStr.split(',')
            .map(s => parseTimeToMinutes(s.trim()))
            .filter(m => m >= 0).sort((a,b) => a - b);
        
        // Check if any schedule matches the current minute
        // And ensure we haven't already sent for this specific minute (deduplication)

        let newestPastTime = null;
        for (const time of scheduledMinutes) {
            if (time < currentMinutes) {
                newestPastTime = time;
                continue;
            };
            break;
        }
        // We are before the first trigger
        if (newestPastTime === null) {
            return;
        }
        // check if we have a date rollover 
        // last checked time is highest possible event &&
        // last checked time is from the day before (this is to prevent the last alarm at 18:00 clearing the lastSend and then being retriggerd)
        if (lastSentSchedule[severity] >= scheduledMinutes.at(-1) && lastSentSchedule[severity] > currentMinutes) {
            lastSentSchedule[severity] = -1;
        }
        
        // We have already sent this summary
        if (newestPastTime === lastSentSchedule[severity]) {
            return;
        }

        // If we hit this code, we are actually sending a summary

        const timeStr = `${Math.floor(currentMinutes / 60).toString().padStart(2, '0')}:${(currentMinutes % 60).toString().padStart(2, '0')}`;
        console.log(`Triggering ${severity} Summary at ${timeStr} UTC (minute ${currentMinutes})`);
        
        await sendSummary(severity);
        lastSentSchedule[severity] = newestPastTime;
         
    };

    await checkSchedule('CRIT', SUMMARY_SCHEDULE_CRIT || "6:00,14:30");
    await checkSchedule('WARN', SUMMARY_SCHEDULE_WARN || "6:00,14:30");
};

// Check every minute
setInterval(checkSummariesAndMentions, 60 * 1000);

app.use(express.json());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    matrix.listJoinedRooms();
});
