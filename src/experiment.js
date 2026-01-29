import { config } from './config.js';

const MATRIX_HOMESERVER_URL = config.MATRIX_HOMESERVER_URL;
const MATRIX_ACCESS_TOKEN = config.MATRIX_ACCESS_TOKEN;
const MATRIX_ROOM_ID = config.MATRIX_ROOM_ID;

const sendMatrixNotification = async (messageContent, formattedBody = null) => {
    console.log(`Sending Matrix notification (length: ${messageContent.length})`);
    if (!MATRIX_ACCESS_TOKEN || !MATRIX_ROOM_ID) {
        console.error('Missing Matrix config, cannot send notification');
        return null;
    }
    const txnId = new Date().getTime() + '_' + Math.random().toString(36).substr(2, 9);
    const url = `${MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(MATRIX_ROOM_ID)}/send/m.room.message/${txnId}`;

    const body = {
        body: messageContent,
        msgtype: "m.text"
    };

    if (formattedBody) {
        body.format = "org.matrix.custom.html";
        body.formatted_body = formattedBody;
    } else {
        // Default simple formatting if none provided
        body.format = "org.matrix.custom.html";
        body.formatted_body = messageContent
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/## (.*?)(\n|<br>)/, '<h3>$1</h3>')
            .replace(/\b(.*?)\b\((.*?)\)/g, '<a href="$2">$1</a>');
    }
    console.log(body.formatted_body)
    try {
        const response = await fetch(url, {
            method: 'PUT',
            body: JSON.stringify(body),
            headers: {
                'Authorization': `Bearer ${MATRIX_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(`Matrix event sent: ${data.event_id}`);
        return data.event_id;
    } catch (error) {
        console.error('Failed to send Matrix notification:', error.message);
        return null;
    }
};

async function runExperiments() {
    console.log("Starting experiments...");

    // Experiment 1: Standard Format (simulating what index.js does)
    console.log("Sending Experiment 1: Standard Format...");
    let stdMessage = `## 🚨 CRIT: High CPU usage (non-existent.netd.cs.tu-dresden.de)
    Average CPU usage over last 15min: 89.83% (> 80%)`;
    //await sendMatrixNotification(stdMessage);

    console.log("Sending Experiment 1: Standard Format...");
    stdMessage = `## 🚨 FIRING: High CPU usage 
    non-existent.netd.cs.tu-dresden.de
    Average CPU usage over last 15min: 89.83% (> 80%)`;

    //await sendMatrixNotification(stdMessage);
    
    console.log("Sending Experiment 1: Standard Format...");
    stdMessage = `**🚨 CRIT: High CPU usage**
    **non-existent.netd.cs.tu-dresden.de**
    Average CPU usage over last 15min: 89.83% (> 80%)`;

    //await sendMatrixNotification(stdMessage);
    stdMessage = `**🚨 CRIT: High CPU usage**
    **💻️ HOST: non-existent.netd.cs.tu-dresden.de**
    Average CPU usage over last 15min: 89.83% (> 80%)`;

    //await sendMatrixNotification(stdMessage);

    stdMessage = `<font color="#d20000ff">**🚨 CRIT: High CPU usage**</font>
    **💻️ HOST: non-existent.netd.cs.tu-dresden.de**
    Average CPU usage over last 15min: 89.83% (> 80%)`;

    //await sendMatrixNotification(stdMessage);

    stdMessage = `<font color="#ff9100ff">**⚠️ WARN: High CPU usage**</font>
    **💻️ HOST: non-existent.netd.cs.tu-dresden.de**
    Average CPU usage over last 15min: 89.83% (> 80%)`;

    //await sendMatrixNotification(stdMessage);
    stdMessage = `<font color="#007a00ff">**Resolved CRIT: High CPU usage**</font>
    **💻️ HOST: non-existent.netd.cs.tu-dresden.de**
    Average CPU usage over last 15min: 75% (> 80%)`;

    await sendMatrixNotification(stdMessage);

    let summaryMessage = `## 📋 CRIT Alert Summary\n`;
            
    summaryMessage += `**Host: non-existent1.netd.cs.tu-dresden.de**\n`;
                                        
    summaryMessage += `- High CPU usage: Average CPU usage over last 15min: 89.83% (> 80%)\n`;
    summaryMessage += `- High CPU usage: Average CPU usage over last 15min: 89.83% (> 80%)\n`;

    summaryMessage += `\n`;
    summaryMessage += `**Host: non-existent2.netd.cs.tu-dresden.de**\n`;
                                        
    summaryMessage += `- High CPU usage: Average CPU usage over last 15min: 89.83% (> 80%)\n`;
    summaryMessage += `- High CPU usage: Average CPU usage over last 15min: 89.83% (> 80%)\n`;

    summaryMessage += `\n`;  

    //await sendMatrixNotification(summaryMessage);


    // Experiment 2: HTML Table Layout
    console.log("Sending Experiment 2: HTML Table Layout...");
    const tableHtml = `
<h3>🚨 Alert: High Memory</h3>
<table>
  <tr><td><b>Severity:</b></td><td>CRITICAL</td></tr>
  <tr><td><b>Host:</b></td><td>database-prod</td></tr>
  <tr><td><b>Value:</b></td><td>98%</td></tr>
</table>
<br>
<a href="https://example.com">View Dashboard</a>
    `;
    // For the plain text fallback, we should provide a readable version
    const tableText = `Alert: High Memory
Severity: CRITICAL
Host: database-prod
Value: 98%
View Dashboard: https://example.com`;
    
    //await sendMatrixNotification(tableText, tableHtml);

    // Experiment 3: Blockquote and color styles (Matrix support for CSS is limited but we can try basic tags)
    console.log("Sending Experiment 3: Blockquote...");
    const blockquoteHtml = `
<font color="#ff0000"><h3>🔥 FIRE IN THE DISCO</h3></font>
<blockquote>
  Something went wrong in the server room.<br>
  <em>Please check immediately.</em>
</blockquote>
    `;
    const blockquoteText = `FIRE IN THE DISCO
Something went wrong in the server room.
Please check immediately.`;

    //await sendMatrixNotification(blockquoteText, blockquoteHtml);

    console.log("Experiments finished.");
}

runExperiments();
