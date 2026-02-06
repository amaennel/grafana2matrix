import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Parse command line arguments to find config file
const args = process.argv.slice(2);
let configFileName = 'config.json';

const configArgIndex = args.indexOf('--config');
if (configArgIndex !== -1 && args[configArgIndex + 1]) {
    configFileName = args[configArgIndex + 1];
    if (!fs.existsSync(path.resolve(process.cwd(), configFileName))) {
        console.warn("Specified config file does not exist!");
    }

}

const CONFIG_PATH = path.resolve(process.cwd(), configFileName);

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
    const value = process.env[key] ?? fileConfig[key];

    if (value === undefined) return defaultValue;

    // While using env variables always produces a string, config.json can indeed contain a boolean.
    if (typeof value === 'boolean') return value;

    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return value;
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
    config.SUMMARY_SCHEDULE_SKIP_EMPTY = get('SUMMARY_SCHEDULE_SKIP_EMPTY', false);
    config.MENTION_CONFIG_PATH = get('MENTION_CONFIG_PATH');
    config.DB_FILE = get('DB_FILE', 'alerts.db');
}

// Initial load
reloadConfig();
