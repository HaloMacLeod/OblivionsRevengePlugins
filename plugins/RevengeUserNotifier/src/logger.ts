import { storage } from "@vendetta/plugin";

export type PluginLogEntry = {
  timestamp: string;
  message: string;
};

const MAX_LOG_ENTRIES = 100;

export function logPluginEvent(message: string) {
  try {
    const logs: PluginLogEntry[] = Array.isArray(storage.webhookLogs)
      ? storage.webhookLogs
      : [];
    storage.webhookLogs = [
      { timestamp: new Date().toISOString(), message },
      ...logs,
    ].slice(0, MAX_LOG_ENTRIES);
  } catch {
    // Logging must never interfere with plugin event handling.
  }
}