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

  // Maps Matrix events to alerts. A single event can reference multiple alerts
  // (e.g. persistent alert notifications), each with its position in the message.
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_alerts (
      event_id TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (event_id, alert_id)
    ) STRICT;
  `);

  // Migrate the legacy single-alert message_map table, if present
  const legacyTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_map'").get();
  if (legacyTable) {
    db.exec(`
      BEGIN;
      INSERT OR IGNORE INTO message_alerts (event_id, alert_id, position)
        SELECT event_id, alert_id, 1 FROM message_map WHERE alert_id IS NOT NULL;
      DROP TABLE message_map;
      COMMIT;
    `);
    console.log('Migrated message_map table to message_alerts');
  }

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

  statements.getAlertIdsFromEvent = db.prepare(
    'SELECT alert_id FROM message_alerts WHERE event_id = ? ORDER BY position'
  );
  statements.getAlertIdFromEventPosition = db.prepare(
    'SELECT alert_id FROM message_alerts WHERE event_id = ? AND position = ?'
  );
  statements.hasMessageMap = db.prepare('SELECT 1 FROM message_alerts WHERE event_id = ?');
  statements.setMessageMap = db.prepare(
    'INSERT OR REPLACE INTO message_alerts (event_id, alert_id, position) VALUES (?, ?, ?)'
  );
  statements.deleteMessageMapByAlertId = db.prepare('DELETE FROM message_alerts WHERE alert_id = ?');
  statements.deleteAllMessageMaps = db.prepare('DELETE FROM message_alerts');

  statements.getLastSentSchedule = db.prepare('SELECT last_sent FROM schedules WHERE severity = ?');
  statements.setLastSentSchedule = db.prepare('INSERT OR REPLACE INTO schedules (severity, last_sent) VALUES (?, ?)');

  statements.getBotState = db.prepare('SELECT value FROM bot_state WHERE key = ?');
  statements.setBotState = db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)');
  statements.deleteBotState = db.prepare('DELETE FROM bot_state WHERE key = ?');
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
export function getAlertIdsFromEvent(eventId) {
  return statements.getAlertIdsFromEvent.all(eventId).map(row => String(row.alert_id));
}

export function getAlertIdFromEventPosition(eventId, position) {
  const row = statements.getAlertIdFromEventPosition.get(eventId, position);
  return row ? String(row.alert_id) : undefined;
}

export function hasMessageMap(eventId) {
    const row = statements.hasMessageMap.get(eventId);
    return !!row;
}

export function setMessageMap(eventId, alertId, position = 1) {
  statements.setMessageMap.run(eventId, alertId, position);
}

export function deleteMessageMapByAlertId(alertId) {
  statements.deleteMessageMapByAlertId.run(alertId);
}

export function deleteAllMessageMaps() {
  statements.deleteAllMessageMaps.run();
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

export function deleteBotState(key) {
  statements.deleteBotState.run(key);
}
