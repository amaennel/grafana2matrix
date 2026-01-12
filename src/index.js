import express from 'express';
import { MatrixServer } from './matrix.js';
import { createMatrixMessage } from './messages.js';
import { isCritical, isWarn, getMentionConfig, parseTimeToMinutes } from './util.js';
import { 
    initDB, 
    getAllActiveAlerts, 
    getActiveAlert, 
    hasActiveAlert, 
    setActiveAlert, 
    deleteActiveAlert, 
    getAlertIdFromEvent, 
    hasMessageMap, 
    setMessageMap, 
    getLastSentSchedule, 
    setLastSentSchedule 
} from './db.js';
import { config, reloadConfig } from './config.js';

const app = express();

initDB();

if (!config.MATRIX_ACCESS_TOKEN || !config.MATRIX_ROOM_ID || !config.MATRIX_HOMESERVER_URL) {
    throw new Error("MATRIX_ACCESS_TOKEN or MATRIX_ROOM_ID or MATRIX_HOMESERVER_URL is not defined in environment variables or config file");
}


app.use(express.json());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

const matrix = new MatrixServer(config.MATRIX_HOMESERVER_URL, config.MATRIX_ROOM_ID, config.MATRIX_ACCESS_TOKEN);

const sendSummary = async (severity) => {
    const alertsForSeverity = [];
    for (const alert of getAllActiveAlerts()) {
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
    } else {
        let summaryMessage = `## 📋 ${severity} Alert Summary\n`;
        summaryMessage += "No active alerts!"
        await matrix.sendMatrixNotification(summaryMessage)
    }
};

async function createGrafanaSilence(alertId, matrixEventId) {
    const alert = getActiveAlert(alertId);
    if (!alert) {
        console.error('Alert not found for silence:', alertId);
        return;
    }

    if (!config.GRAFANA_URL || !config.GRAFANA_API_KEY) {
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
        const response = await fetch(`${config.GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Authorization': `Bearer ${config.GRAFANA_API_KEY}`,
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
        deleteActiveAlert(alertId);

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
        if (hasMessageMap(targetEventId)) {
            const alertId = getAlertIdFromEvent(targetEventId);
            console.log(`Received mute reaction for event ${targetEventId}, alert ${alertId}`);
            await createGrafanaSilence(alertId, targetEventId);
        }
    }
})

matrix.on("userMessage", async (event) => {
    const body = event.content?.body;
    if (!body) {
        return;
    } 

    if (body.startsWith(".summary ")) {
        await matrix.sendReaction(event.event_id, '☑️');
        const parts = body.split(/\s+/);
        if (parts.length > 1) {
            const severity = parts[1].toUpperCase();
            console.log(`Received manual summary request for: ${severity}`);
            await sendSummary(severity);
        } else {
             await matrix.sendMatrixNotification("Usage: .summary <severity> (e.g. CRITICAL, WARNING)");
        }
    }

    if (body === ".reload-config") {
        await matrix.sendReaction(event.event_id, '☑️');
        try {
            console.log("Reloading configuration...");
            reloadConfig();
            
            // Update matrix server instance with new config
            matrix.updateConfig(config.MATRIX_HOMESERVER_URL, config.MATRIX_ROOM_ID, config.MATRIX_ACCESS_TOKEN);

            await matrix.sendReaction(event.event_id, '✅');
            console.log("Configuration reloaded.");
        } catch (error) {
            console.error("Failed to reload config:", error);
            await matrix.sendReaction(event.event_id, '❌');
            await matrix.sendMatrixNotification(`Failed to reload config: ${error.message}`);
        }
    }
});

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
                    if (!hasActiveAlert(id)) {
                        console.log(`New firing alert: ${id} (${alert.labels?.alertname})`);
                        alertsToNotify.push(alert);
                        alert.mentionsSent = { primary: false, secondary: false };
                    } else {
                        const existing = getActiveAlert(id);
                        alert.mentionsSent = existing.mentionsSent || { primary: false, secondary: false };
                    }
                    // Always update/add the alert to map to keep latest state
                    setActiveAlert(id, alert);
                } else if (alertStatus === 'resolved') {
                    if (hasActiveAlert(id)) {
                        console.log(`Alert resolved: ${id} (${alert.labels?.alertname})`);
                        deleteActiveAlert(id);
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
                     setMessageMap(sentEventId, id);
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
    for (const alert of getAllActiveAlerts()) {
        const id = alert.fingerprint;
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
        
        const lastSent = getLastSentSchedule(severity);

        // check if we have a date rollover 
        // last checked time is highest possible event &&
        // last checked time is from the day before (this is to prevent the last alarm at 18:00 clearing the lastSend and then being retriggerd)
        if (lastSent >= scheduledMinutes.at(-1) && lastSent > currentMinutes) {
            setLastSentSchedule(severity, -1);
        }
        
        // We have already sent this summary
        if (newestPastTime === getLastSentSchedule(severity)) {
            return;
        }

        // If we hit this code, we are actually sending a summary

        const timeStr = `${Math.floor(currentMinutes / 60).toString().padStart(2, '0')}:${(currentMinutes % 60).toString().padStart(2, '0')}`;
        console.log(`Triggering ${severity} Summary at ${timeStr} UTC (minute ${currentMinutes})`);
        
        await sendSummary(severity);
        setLastSentSchedule(severity, newestPastTime);
    };

    await checkSchedule('CRIT', config.SUMMARY_SCHEDULE_CRIT || "6:00,14:30");
    await checkSchedule('WARN', config.SUMMARY_SCHEDULE_WARN || "6:00,14:30");
};

// Check every minute
setInterval(checkSummariesAndMentions, 60 * 1000);

app.listen(config.PORT, () => {
    console.log(`Server is running on port ${config.PORT}`);
    matrix.listJoinedRooms();
});