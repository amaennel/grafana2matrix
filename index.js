require('dotenv').config();
const express = require('express');
const axios = require('axios');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || 'https://matrix.org';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID;

console.log(MATRIX_ACCESS_TOKEN, MATRIX_ROOM_ID)

// In-memory store for active alerts (fingerprints) to prevent duplicate notifications
const activeAlerts = new Set();

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

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        
        console.log('Received webhook:', JSON.stringify(data, null, 2));

        if (!MATRIX_ACCESS_TOKEN || !MATRIX_ROOM_ID) {
            console.error('MATRIX_ACCESS_TOKEN or MATRIX_ROOM_ID is not defined in environment variables');
            return res.status(500).send('Server configuration error');
        }

        const sendMatrixNotification = async (messageContent) => {
            const txnId = new Date().getTime() + '_' + Math.random().toString(36).substr(2, 9);
            const url = `${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(MATRIX_ROOM_ID)}/send/m.room.message/${txnId}`;

            await axios.put(url, {
                body: messageContent,
                format: "org.matrix.custom.html",
                formatted_body: messageContent
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                    .replace(/## (.*?)(\n|<br>)/, '<h3>$1</h3>')
                    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>'),
                msgtype: "m.text"
            }, {
                headers: {
                    'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}`
                }
            });
        };

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
                        activeAlerts.add(id);
                        alertsToNotify.push(alert);
                    } else {
                        console.log(`Skipping duplicate firing alert: ${id}`);
                    }
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
                console.log('No state changes detected (all alerts are duplicates). Skipping Matrix notification.');
                return res.status(200).send('No notification needed');
            }

            // Send separate message for each alert
            for (const a of alertsToNotify) {
                const alertName = a.labels?.alertname || 'Unknown Alert';
                const host = a.labels?.host || a.labels?.instance || 'Unknown Host';
                const summary = a.annotations?.summary || '';
                const description = a.annotations?.description || a.annotations?.message || '';
                
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

                const links = [];
                if (isFiring && a.silenceURL) {
                    links.push(`[Silence Alert](${a.silenceURL})`);
                }
                if (ruleUrl) {
                    links.push(`[View in Grafana](${ruleUrl})`);
                }
                
                if (links.length > 0) {
                    matrixMessage += links.join(' | ');
                }

                await sendMatrixNotification(matrixMessage);
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
        if (error.response) {
            console.error('Matrix API Error:', error.response.status, error.response.data);
        }
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
        const res = await axios.get(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/joined_rooms`, {
            headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
        });

        const rooms = res.data.joined_rooms || [];
        console.log(`Joined to ${rooms.length} rooms:`);

        for (const roomId of rooms) {
            let name = '';
            try {
                const nameRes = await axios.get(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                    headers: { 'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}` }
                });
                name = nameRes.data.name;
            } catch (err) {
                // Ignore errors fetching name (e.g. 404 if not set)
            }
            console.log(`- ${roomId}${name ? ` (${name})` : ''}`);
        }
    } catch (error) {
        console.error('Failed to fetch joined rooms:', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    listJoinedRooms();
});
