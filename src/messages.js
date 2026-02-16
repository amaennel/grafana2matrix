import { getAlertValue, getMentionConfig, isCritical, isWarn , getAdditionalLabels } from "./util.js";

const createMatrixMessage = (a) => {

    const alertName = a.labels?.alertname || 'Unknown Alert';
    const host = getAlertValue(a, "host") ?? getAlertValue(a, "instance") ?? "Unknown Host";
    const severity = getAlertValue(a, "severity", "UNKNOWN").toUpperCase();

    const additionalLabels = getAdditionalLabels(a);
    const summary = getAlertValue(a, "summary");
    const description = getAlertValue(a, "description") || getAlertValue(a, "message") || '';
    
    const isFiring = a.status === 'firing';
    let color; 
    let resolved = "";
    if (!isFiring) {
        color = '#007a00';
        resolved = "RESOLVED ";
    }
    else if (isWarn(severity)) {
        color = '#ff9100';
    } else {
        color = '#d20000';
    }

    let matrixMessage = `<font color="${color}">**${resolved}${severity}: ${alertName}**</font>\n`;
    matrixMessage += `**HOST: ${host}**\n`;

    for (const [label, value] of Object.entries(additionalLabels)) {
        matrixMessage += `**${label}: ${value}**\n`;
    }

    if (summary) {
        matrixMessage += `${summary}\n`;
    }
    
    if (description) {
        matrixMessage += `${description}\n`;
    }

    const mentionConfig = getMentionConfig();

    // Check for immediate mentions
    if (isFiring && mentionConfig[host]) {
        const config = mentionConfig[host];
        let immediateMentions = [];

        const checkImmediate = (type) => {
            const delayCrit = config[`delay_crit_${type}`];
            const delayWarn = config[`delay_warn_${type}`];

            if (isCritical(severity)) {
                return delayCrit === 0;
            } else if (isWarn(severity)) {
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
        immediateMentions = [...new Set(immediateMentions)].map(v => `@${v}`);


        if (immediateMentions.length > 0) {
            matrixMessage += `\nAttention: ${immediateMentions.join(' ')}\n`;
        }
    }

    const links = [];
    // if (ruleUrl) {
    //     links.push(`[View in Grafana](${ruleUrl})`);
    // }
    
    if (links.length > 0) {
        matrixMessage += links.join(' | ');
    }
    return matrixMessage;
}

const createPersistentAlertMessage = (alertsWithUsers) => {
    // Expects alertsWithUsers to be an array of { alert, users } where users is the same for all items (logic handled by caller usually)
    // Actually the caller groups by users, so we can assume users are the same for the group passed in.
    
    if (!alertsWithUsers || alertsWithUsers.length === 0) return '';
    
    const users = alertsWithUsers[0].users;
    
    let msg = `## ⚠️ Persistent Alert Notification\n\n`;
    msg += `The following alerts have been active for a significant time:\n\n`;
    
    for (const item of alertsWithUsers) {
        const alertName = item.alert.labels?.alertname || 'Unknown Alert';
        const host = getAlertValue(item.alert, "host") ?? getAlertValue(item.alert, "instance") ?? "Unknown Host";
        const summary = getAlertValue(item.alert, "summary");
        
        msg += `- **${alertName}** on **${host}**`;
        if (summary) {
            msg += `: ${summary}\n`;
        } else {
            msg += '\n';
        }

    }
    
    msg += `\nAttention: ${users.map(v => `@${v}`).join(' ')}`;
    return msg;
};

const createSummaryMessage = (severity, alertsForSeverity, silences = []) => {

    if (alertsForSeverity.length === 0) {
        let summaryMessage = `## 📋 ${severity} Alert Summary\n`;
        summaryMessage += "No active alerts!"
        return summaryMessage;
    }

    // Group by host
    const alertsByHost = {};
    for (const alert of alertsForSeverity) {
        const host = getAlertValue(alert, "host") ?? getAlertValue(alert, "instance") ?? "Unknown Host";
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
            const summary = getAlertValue(alert, "summary") || getAlertValue(alert, "description") || '';
            const additionalLabels = Object.values(getAdditionalLabels(alert)).join(', ');;

            summaryMessage += `- ${alertName}${additionalLabels ? ` (${additionalLabels})` : ''}${summary ? `: ${summary}` : ''}\n`;
        }
        summaryMessage += `\n`;
    }

    summaryMessage += `\nThere are currently ${silences.length} silenced alerts for this severity. (List them with .silences)\n`
    return summaryMessage;
}

const createSilencesMessage = (silences) => {
    if (!silences || silences.length === 0) {
        return "## 🔇 Active Silences\n\nNo active silences found.";
    }

    let message = `## 🔇 Active Silences (${silences.length})\n\n`;

    // Sort by end time, soonest first
    silences.sort((a, b) => {
        const dateA = new Date(a.endsAt);
        const dateB = new Date(b.endsAt);
        if (isNaN(dateA.getTime())) return 1;
        if (isNaN(dateB.getTime())) return -1;
        return dateA.getTime() - dateB.getTime();
    });

    for (const silence of silences) {
        const start = new Date(silence.startsAt).toLocaleString("en-GB");
        const end = new Date(silence.endsAt).toLocaleString("en-GB");
        const createdBy = silence.createdBy || 'Unknown';
        const comment = silence.comment || 'No comment';
        
        // Extract matchers to show what is silenced
        const matchers = silence.matchers
            .filter(m => m.name !== 'alertname') // Optional: hide alertname if redundant, but usually we want to see it
            .map(m => `**${m.name}**: ${m.value}`)
            .join(', ');
        
        // Try to find alertname specifically for better title
        const alertnameMatcher = silence.matchers.find(m => m.name === 'alertname');
        const alertname = alertnameMatcher ? alertnameMatcher.value : 'Global/Unknown';

        message += `### ${alertname}\n`;
        message += `- **Matchers**: ${matchers}\n`;
        message += `- **Duration**: ${start} to ${end}\n`;
        message += `- **Created By**: ${createdBy}\n`;
        message += `- **Comment**: ${comment}\n\n`;
    }

    return message;
};

export { createMatrixMessage, createPersistentAlertMessage, createSummaryMessage, createSilencesMessage };