import express from 'express';
import { MatrixServer } from './matrix.js';
import { createMatrixMessage, createSummaryMessage, createSilencesMessage } from './messages.js';
import { isCritical, isWarn, checkMentionMessages, checkSchedule, getSilencesFilterFunction, getSeverityMatchFunction } from './util.js';
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
    deleteMessageMapByAlertId,
    getBotState,
    setBotState} from './db.js';
import { config, reloadConfig } from './config.js';
import { sendGrafanaSilence, fetchGrafanaSilences } from './grafana.js';

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

const sendSummary = async (severity, enforceSending = false) => {
    const alertsForSeverity = [];
    
    const matcherFunc = getSeverityMatchFunction(severity);

    for (const alert of getAllActiveAlerts()) {
        const sev = (alert.labels?.severity || alert.annotations?.severity || 'UNKNOWN').toUpperCase();        

        if (matcherFunc(sev)) {
            alertsForSeverity.push(alert);
        }
    }

    if (config.SUMMARY_SCHEDULE_SKIP_EMPTY && alertsForSeverity.length === 0 && !enforceSending) {
        console.log(`Skipping summary for severity: ${severity}`);
        return;
    } else {
        console.log(`Sending summary for severity: ${severity}`);
        const silencesWithSeverity = (await fetchGrafanaSilences()).filter(getSilencesFilterFunction(severity));
        const summaryMessage = createSummaryMessage(severity, alertsForSeverity, silencesWithSeverity);
        await matrix.sendMatrixNotification(summaryMessage);
    }
};

async function createGrafanaSilence(alertId, matrixEventId) {
    const alert = getActiveAlert(alertId);

    if (!alert) {
        console.error('Alert not found for silence:', alertId);
        return;
    }

    const silenceResult = sendGrafanaSilence(alert, new Date());
    let reaction = '☑️';
    if (silenceResult) {
        console.log(`Alert ${alertId} silenced successfully.`);
        
        await matrix.sendMatrixNotification(`🔇 Alert silenced for 24h: ${alert.annotations.severity} ${alert.labels.host} ${alert.labels.alertname}`);
        deleteActiveAlert(alertId);
        deleteMessageMapByAlertId(alertId);


    } else {
        await matrix.sendMatrixNotification(`Alert could not be silenced: ${alert.annotations.severity} ${alert.labels.host} ${alert.labels.alertname}`);
        reaction = '⛔️';
    }

    if (matrixEventId) {
        matrix.sendReaction(matrixEventId, reaction);
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

matrix.on("loop", () => {
    setBotState('last_matrix_received', new Date().toISOString());
})

matrix.on("userMessage", async (event) => {
    const body = event.content?.body;
    if (!body) {
        return;
    } 

    if (body.startsWith(".summary")) {
        await matrix.sendReaction(event.event_id, '☑️');
        const parts = body.split(/\s+/);
        if (parts.length > 1) {
            const severity = parts[1].toUpperCase();
            console.log(`Received manual summary request for: ${severity}`);
            await sendSummary(severity, true);
        } else {
            await matrix.sendMatrixNotification("Usage: .summary <severity> (e.g. CRITICAL, WARNING)");
        }
    }

    if (body.startsWith(".silences")) {
        await matrix.sendReaction(event.event_id, '☑️');
        let filterFunc = () => true;
        const parts = body.split(/\s+/);

        if (parts.length > 1) {
            filterFunc = getSilencesFilterFunction(parts[1]);
        }

        try {
            console.log("Fetching silences...");
            const silences = (await fetchGrafanaSilences()).filter(filterFunc);
            const message = createSilencesMessage(silences);
            await matrix.sendMatrixNotification(message);
        } catch (error) {
            console.error("Failed to fetch silences:", error);
            await matrix.sendReaction(event.event_id, '❌');
            await matrix.sendMatrixNotification(`Failed to fetch silences: ${error.message}`);
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

        setBotState('last_webhook_received', new Date().toISOString());

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
                        deleteMessageMapByAlertId(id);
                        alertsToNotify.push(alert);
                    } else {
                        alertsToNotify.push(alert);
                    }
                }
            }

            if (alertsToNotify.length === 0) {
                console.log('No state changes detected (all alerts are duplicates). Skipping individual Matrix notification.');

                const messages = checkMentionMessages(data.alerts, "webhook");

                for (const msg of messages) {
                    await matrix.sendMatrixNotification(msg);
                }

                return res.status(200).send('Processed');
            }

            // Send separate message for each alert
            for (const a of alertsToNotify) {
               
                const matrixMessage = createMatrixMessage(a);

                const sentEventId = await matrix.sendMatrixNotification(matrixMessage);
                if (sentEventId && a.status === 'firing') {
                     const id = a.fingerprint;
                     setMessageMap(sentEventId, id);
                }
            }

            // Prune zombie alerts (alerts that are in DB but not in the current webhook request, but ONLY for alertnames present in the webhook)
            const receivedAlertIds = new Set(data.alerts.map(a => a.fingerprint));
            const receivedAlertNames = new Set(data.alerts.map(a => a.labels?.alertname).filter(Boolean));
            const activeAlerts = getAllActiveAlerts();

            for (const activeAlert of activeAlerts) {
                const activeAlertName = activeAlert.labels?.alertname;
                if (activeAlertName && receivedAlertNames.has(activeAlertName) && !receivedAlertIds.has(activeAlert.fingerprint)) {
                    console.log(`Pruning zombie alert: ${activeAlert.fingerprint} (${activeAlertName})`);
                    deleteActiveAlert(activeAlert.fingerprint);
                    deleteMessageMapByAlertId(activeAlert.fingerprint);
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

let counter = 0;
// Periodic Summary Logic
const checkSummariesAndMentions = async () => {
    if (counter === 0) {

        let lastWebhook = getBotState('last_webhook_received');
        let lastMatrix = getBotState('last_matrix_received');

        if (lastWebhook) {
            lastWebhook = new Date(lastWebhook).toLocaleString("en-GB");
        } else {
            lastWebhook = 'Never';
        }

        if (lastMatrix) {
            lastMatrix = new Date(lastMatrix).toLocaleString("en-GB");
        } else {
            lastMatrix = 'Never';
        }
        const statusMessage = `Last Matrix Check: ${lastMatrix} (UTC) Last Webhook received: ${lastWebhook} (UTC)`;
        const storedStatusId = getBotState('status_message_id');
        
        if (storedStatusId) {
            // Try to edit
            await matrix.editMessage(storedStatusId, statusMessage);
        } else {
            // Create new
            const newId = await matrix.sendMatrixNotification(statusMessage);
            await matrix.sendMatrixNotification("The above message will be updated continuously. Consider pining it to the channel.")
            if (newId) {
                setBotState('status_message_id', newId);
            }
        }
    }   
    counter = (counter + 1) % 5;
    
    // Check mentions
    const messages = checkMentionMessages(getAllActiveAlerts(), "loop");

     for (const msg of messages) {
        await matrix.sendMatrixNotification(msg);
    }

    // Check for summaries
    const nowUtc = new Date();
    // Calculate minutes from midnight (0-1439)
    const currentMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();

    const sendCrit = await checkSchedule('CRIT', currentMinutes, config.SUMMARY_SCHEDULE_CRIT || "6:00,14:30");
    const sendWarn = await checkSchedule('WARN', currentMinutes, config.SUMMARY_SCHEDULE_WARN || "6:00,14:30");

    if (sendCrit) sendSummary("CRIT");
    if (sendWarn) sendSummary("WARN");
};

// Check every minute
setInterval(checkSummariesAndMentions, 60 * 1000);

app.listen(config.PORT, () => {
    console.log(`Server is running on port ${config.PORT}`);
    matrix.listJoinedRooms();
});