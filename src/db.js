import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dbPath = config.DB_FILE;
const db = new DatabaseSync(dbPath);

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
}

// Active Alerts
export function getAllActiveAlerts() {
  const rows = db.prepare('SELECT id, data FROM active_alerts').all();
  return rows.map(row => {
      const alert = JSON.parse(String(row.data));
      // Ensure fingerprint is available if it wasn't already (though it should be)
      if (!alert.fingerprint) alert.fingerprint = String(row.id); 
      return alert;
  });
}

export function getActiveAlert(id) {
  const row = db.prepare('SELECT data FROM active_alerts WHERE id = ?').get(id);
  if (!row) return undefined;
  return JSON.parse(String(row.data));
}

export function hasActiveAlert(id) {
  const row = db.prepare('SELECT 1 FROM active_alerts WHERE id = ?').get(id);
  return !!row;
}

export function setActiveAlert(id, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO active_alerts (id, data) VALUES (?, ?)');
  stmt.run(id, JSON.stringify(data));
}

export function deleteActiveAlert(id) {
  const stmt = db.prepare('DELETE FROM active_alerts WHERE id = ?');
  stmt.run(id);
}

// Message Map
export function getAlertIdFromEvent(eventId) {
  const row = db.prepare('SELECT alert_id FROM message_map WHERE event_id = ?').get(eventId);
  return row ? String(row.alert_id) : undefined;
}

export function hasMessageMap(eventId) {
    const row = db.prepare('SELECT 1 FROM message_map WHERE event_id = ?').get(eventId);
    return !!row;
}

export function setMessageMap(eventId, alertId) {
  const stmt = db.prepare('INSERT OR REPLACE INTO message_map (event_id, alert_id) VALUES (?, ?)');
  stmt.run(eventId, alertId);
}

// Schedules
export function getLastSentSchedule(severity) {
  const row = db.prepare('SELECT last_sent FROM schedules WHERE severity = ?').get(severity);
  return row ? Number(row.last_sent) : -1;
}

export function setLastSentSchedule(severity, time) {
  const stmt = db.prepare('INSERT OR REPLACE INTO schedules (severity, last_sent) VALUES (?, ?)');
  stmt.run(severity, time);
}