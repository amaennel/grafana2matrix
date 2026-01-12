import fs from 'fs';
import { config } from './config.js';

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

const isCritical = (severity) => severity.toUpperCase() === 'CRITICAL' || severity.toUpperCase() === 'CRIT';
const isWarn  = (severity) => severity.toUpperCase() === 'WARNING' || severity.toUpperCase() === 'WARN';

export { getMentionConfig, isCritical, isWarn, parseTimeToMinutes };