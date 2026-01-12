import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_FILE = 'config.json';
const CONFIG_PATH = path.resolve(process.cwd(), CONFIG_FILE);

let fileConfig = {};

function loadFileConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
            fileConfig = JSON.parse(fileContent);
            console.log(`Loaded configuration from ${CONFIG_PATH}`);
        } catch (error) {
            console.error(`Error reading ${CONFIG_PATH}:`, error.message);
        }
    } else {
        fileConfig = {};
    }
}

const get = (key, defaultValue) => {
    if (process.env[key] !== undefined) {
        return process.env[key];
    }
    if (fileConfig[key] !== undefined) {
        return fileConfig[key];
    }
    return defaultValue;
};

export const config = {};

export function reloadConfig() {
    loadFileConfig();
    
    config.PORT = get('PORT', 3000);
    config.MATRIX_HOMESERVER_URL = get('MATRIX_HOMESERVER_URL', 'https://matrix.org');
    config.MATRIX_ACCESS_TOKEN = get('MATRIX_ACCESS_TOKEN');
    config.MATRIX_ROOM_ID = get('MATRIX_ROOM_ID');
    config.GRAFANA_URL = get('GRAFANA_URL');
    config.GRAFANA_API_KEY = get('GRAFANA_API_KEY');
    config.SUMMARY_SCHEDULE_CRIT = get('SUMMARY_SCHEDULE_CRIT');
    config.SUMMARY_SCHEDULE_WARN = get('SUMMARY_SCHEDULE_WARN');
    config.MENTION_CONFIG_PATH = get('MENTION_CONFIG_PATH');
    config.DB_FILE = get('DB_FILE', 'alerts.db');
}

// Initial load
reloadConfig();
