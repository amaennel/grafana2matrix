import { getMentionConfig, isCritical, isWarn } from "./util.js";

const createMatrixMessage = (a) => {

    const alertName = a.labels?.alertname || 'Unknown Alert';
    const host = a.labels?.host || a.labels?.instance || 'Unknown Host';
    const summary = a.annotations?.summary || '';
    const description = a.annotations?.description || a.annotations?.message || '';
    const severity = (a.annotations?.severity || '').toUpperCase();
    
    const isFiring = a.status === 'firing';
    let color; 

    if (!isFiring) {
        color = '#007a00';
    }
    else if (isWarn(severity)) {
        color = '#ff9100';
    } else {
        color = '#d20000';
    }

    let matrixMessage = `<font color="${color}">**${severity}: ${alertName}**</font>\n`;
    matrixMessage += `**HOST: ${host}**\n`;

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

export { createMatrixMessage };