import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dbPath = config.DB_FILE;
const db = new DatabaseSync(dbPath);

const statements = {};

export function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_alerts (
      id TEXT PRIMARY KEY,
      data TEXT
    ) STRICT;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_map (
      event_id TEXT PRIMARY KEY,
      alert_id TEXT
    ) STRICT;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      severity TEXT PRIMARY KEY,
      last_sent INTEGER
    ) STRICT;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT
    ) STRICT;
  `);

  // Prepare statements once
  statements.getAllActiveAlerts = db.prepare('SELECT id, data FROM active_alerts');
  statements.getActiveAlert = db.prepare('SELECT data FROM active_alerts WHERE id = ?');
  statements.hasActiveAlert = db.prepare('SELECT 1 FROM active_alerts WHERE id = ?');
  statements.setActiveAlert = db.prepare('INSERT OR REPLACE INTO active_alerts (id, data) VALUES (?, ?)');
  statements.deleteActiveAlert = db.prepare('DELETE FROM active_alerts WHERE id = ?');

  statements.getAlertIdFromEvent = db.prepare('SELECT alert_id FROM message_map WHERE event_id = ?');
  statements.hasMessageMap = db.prepare('SELECT 1 FROM message_map WHERE event_id = ?');
  statements.setMessageMap = db.prepare('INSERT OR REPLACE INTO message_map (event_id, alert_id) VALUES (?, ?)');
  statements.deleteMessageMapByAlertId = db.prepare('DELETE FROM message_map WHERE alert_id = ?');

  statements.getLastSentSchedule = db.prepare('SELECT last_sent FROM schedules WHERE severity = ?');
  statements.setLastSentSchedule = db.prepare('INSERT OR REPLACE INTO schedules (severity, last_sent) VALUES (?, ?)');

  statements.getBotState = db.prepare('SELECT value FROM bot_state WHERE key = ?');
  statements.setBotState = db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)');
}

// Active Alerts
export function getAllActiveAlerts() {
  const rows = statements.getAllActiveAlerts.all();
  return rows.map(row => {
      const alert = JSON.parse(String(row.data));
      // Ensure fingerprint is available if it wasn't already (though it should be)
      if (!alert.fingerprint) alert.fingerprint = String(row.id); 
      return alert;
  });
}

export function getActiveAlert(id) {
  const row = statements.getActiveAlert.get(id);
  if (!row) return undefined;
  return JSON.parse(String(row.data));
}

export function hasActiveAlert(id) {
  const row = statements.hasActiveAlert.get(id);
  return !!row;
}

export function setActiveAlert(id, data) {
  statements.setActiveAlert.run(id, JSON.stringify(data));
}

export function deleteActiveAlert(id) {
  statements.deleteActiveAlert.run(id);
}

// Message Map
export function getAlertIdFromEvent(eventId) {
  const row = statements.getAlertIdFromEvent.get(eventId);
  return row ? String(row.alert_id) : undefined;
}

export function hasMessageMap(eventId) {
    const row = statements.hasMessageMap.get(eventId);
    return !!row;
}

export function setMessageMap(eventId, alertId) {
  statements.setMessageMap.run(eventId, alertId);
}

export function deleteMessageMapByAlertId(alertId) {
  statements.deleteMessageMapByAlertId.run(alertId);
}

// Schedules
export function getLastSentSchedule(severity) {
  const row = statements.getLastSentSchedule.get(severity);
  return row ? Number(row.last_sent) : -1;
}

export function setLastSentSchedule(severity, time) {
  statements.setLastSentSchedule.run(severity, time);
}

// Bot State
export function getBotState(key) {
  const row = statements.getBotState.get(key);
  return row ? String(row.value) : undefined;
}

export function setBotState(key, value) {
  statements.setBotState.run(key, value);
}
