import fs from 'fs';

const MENTION_CONFIG_PATH = process.env.MENTION_CONFIG_PATH;

// Helper to get mention config
const getMentionConfig = () => {
    if (!MENTION_CONFIG_PATH) return {};
    try {
        if (fs.existsSync(MENTION_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(MENTION_CONFIG_PATH, 'utf8'));
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