import fs from 'fs';
import { config } from './config.js';
import { createPersistentAlertMessage } from './messages.js';
import { getLastSentSchedule, setLastSentSchedule } from './db.js';

// Helper to get mention config
const getMentionConfig = () => {
    if (!config.MENTION_CONFIG_PATH) return {};
    try {
        if (fs.existsSync(config.MENTION_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(config.MENTION_CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading mention config:', e.message);
    }
    return {};
};

// Helper to parse HH:mm to minutes
const parseTimeToMinutes = (timeStr) => {
    if (!timeStr) return -1;
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return -1;
    return hours * 60 + minutes;
};

const getScheduleTimestamp = (minuteOfDay) => {
    const now = new Date();
    const hours = Math.floor(minuteOfDay / 60);
    const minutes = minuteOfDay % 60;
    return Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hours,
        minutes,
        0,
        0
    );
};

const sortAlertsByUsers = (alerts) => {
    const groups = {};
    for (const item of alerts) {
        const key = item.users.join(',');
        if (!groups[key]) groups[key] = { users: item.users, alerts: [] };
        groups[key].alerts.push(item);
    }
    return groups;
}

const isCritical = (severity) => severity.toUpperCase() === 'CRITICAL' || severity.toUpperCase() === 'CRIT';
const isWarn  = (severity) => severity.toUpperCase() === 'WARNING' || severity.toUpperCase() === 'WARN';

const checkMention = (conf, alert, type, strategy) => {

    const severity = getAlertValue(alert, "severity", "UNKNOWN").toUpperCase();
    const startsAt = new Date(alert.startsAt).getTime();
    const durationMinutes = (Date.now() - startsAt) / (1000 * 60);

    let repeat = undefined;
    let delay = -1;
    if (isCritical(severity)) {
        repeat = conf[`repeat_crit_${type}`];
        delay = conf[`delay_crit_${type}`];
    } else if (isWarn(severity)) {
        repeat = conf[`repeat_warn_${type}`];
        delay = conf[`delay_warn_${type}`];
    }
    
    // Never mention
    if (delay < 0) return false;

    // Mention threshold not hit
    if (durationMinutes < delay) return false;

    // Repeat is set to fire on summary (or not set at all)
    if (repeat === undefined || repeat === null) {
        return strategy === "webhook";
    }

    // Every run of the loop (i.e. every minute)
    if (repeat === 0 && strategy === "loop") return true; 

    // Normal repeat interval
    const lastSentKey = `last_sent_${type}`;
    const lastSent = alert.mentionsSent?.[lastSentKey] || 0;
    
    // Never repeat, so check if we ever sent out a mention
    if (repeat < 0) {
        return lastSent === 0;
    }
    // Either the first mention or regular interval

    const now = Date.now();
    
    if ((now - lastSent) >= repeat * 60 * 1000) {
        if (!alert.mentionsSent) alert.mentionsSent = {};
        alert.mentionsSent[lastSentKey] = now;
        return true;
    }
    
    return false;
};

const checkMentionMessages = (alerts, strategy) => {

    const mentionConfig = getMentionConfig();
    const mentions = [];
    const messagesToReturn = [];

    for (const alert of alerts) {
        const host = getAlertValue(alert, "host") ?? getAlertValue(alert, "instance") ?? "Unknown Host";

        const id = alert.fingerprint;

        if (host && mentionConfig[host]) {
            const conf = mentionConfig[host];
            
            let usersToMention = [];

            if (checkMention(conf, alert, 'secondary', strategy)) {
                usersToMention.push(...conf['secondary']);
            }
            if (checkMention(conf, alert, 'primary', strategy)) {
                usersToMention.push(...conf['primary']);
            }
            
            usersToMention = [...new Set(usersToMention)];
            
            if (usersToMention.length > 0) {
                mentions.push({ id, alert, users: usersToMention.sort() });
            }
        }
    }

    // Return persistent notifications if any
    if (mentions.length > 0) {
        const groups = sortAlertsByUsers(mentions);

        for (const key in groups) {
            const msg = createPersistentAlertMessage(groups[key].alerts);
            messagesToReturn.push(msg);
        }
    }
    return messagesToReturn;
}

const checkSchedule = async (severity, scheduleStr) => {
        if (!scheduleStr) return false;
        
        const scheduledTimestamps = scheduleStr.split(',')
            .map(s => parseTimeToMinutes(s.trim()))
            .filter(m => m >= 0)
            .sort((a, b) => a - b)
            .map(minutes => getScheduleTimestamp(minutes));

        if (scheduledTimestamps.length === 0) {
            return false;
        }

        let lastSent = Number(getLastSentSchedule(severity));

        // convert old date mode to new (v0.1.9)
        if (lastSent < 10000) {
            const convertedLastSent = getScheduleTimestamp(lastSent);
            setLastSentSchedule(severity, convertedLastSent);
            lastSent = convertedLastSent;
        }

        for (const scheduledTimestamp of scheduledTimestamps) {

            if (scheduledTimestamp < Date.now() && lastSent < scheduledTimestamp) {
                const date = new Date(scheduledTimestamp);
                console.log(`Triggering ${severity} Summary at ${date.getUTCHours()}:${date.getUTCMinutes()} UTC`);
    
                setLastSentSchedule(severity, scheduledTimestamp);
                return true;
            }

        }

    };

const getSeverityMatchFunction = (severity) => {
    let matcherFunc = sev => sev === severity;
    
    if (isCritical(severity)) {
        matcherFunc = isCritical;
    } else if (isWarn(severity)) {
        matcherFunc = isWarn;
    }

    return matcherFunc;
    
}

const getSilencesFilterFunction = (severity) => {
    const matcherFunc = getSeverityMatchFunction(severity);

    return e => matcherFunc(e.matchers.find(v => v.name === "severity").value)
}

const getAlertValue = (a, label, defaultValue = undefined) => {
    return a.labels[label] || a.annotations[label] || defaultValue;
}

const getAdditionalLabels = (alert) => {
    const labels = {};
    if (config.ADDITIONAL_LABELS) {
        for (const label of config.ADDITIONAL_LABELS.split(',')) {
            const value = getAlertValue(alert, label);
            if (value) {
                labels[label] = value;
            }
        }
    }

    return labels;
};

export { getMentionConfig, isCritical, isWarn, parseTimeToMinutes, sortAlertsByUsers, checkMentionMessages, checkSchedule, getSeverityMatchFunction, getSilencesFilterFunction, getAlertValue, getAdditionalLabels };
