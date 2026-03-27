import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface SystemAlert {
  id: string;
  timestamp: string;
  service: string;
  message: string;
  fixInstructions?: string;
  resolved?: boolean;
}

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'system-alerts.json');

function readAlerts(filePath = DEFAULT_PATH): SystemAlert[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SystemAlert[];
  } catch {
    return [];
  }
}

function writeAlerts(alerts: SystemAlert[], filePath = DEFAULT_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(alerts, null, 2), 'utf-8');
}

export function appendAlert(
  alert: Omit<SystemAlert, 'id'>,
  filePath = DEFAULT_PATH,
): SystemAlert {
  const full: SystemAlert = { id: randomUUID(), ...alert };
  const alerts = readAlerts(filePath);
  alerts.push(full);
  writeAlerts(alerts, filePath);
  logger.error({ tag: 'SYSTEM_ALERT', service: full.service }, full.message);
  return full;
}

export function getUnresolvedAlerts(filePath = DEFAULT_PATH): SystemAlert[] {
  return readAlerts(filePath).filter((a) => !a.resolved);
}

export function resolveAlert(id: string, filePath = DEFAULT_PATH): void {
  const alerts = readAlerts(filePath);
  const alert = alerts.find((a) => a.id === id);
  if (alert) {
    alert.resolved = true;
    writeAlerts(alerts, filePath);
  }
}

export function cleanupAlerts(filePath = DEFAULT_PATH): void {
  const cutoff = Date.now() - 24 * 3600_000;
  const alerts = readAlerts(filePath).filter(
    (a) => new Date(a.timestamp).getTime() > cutoff,
  );
  writeAlerts(alerts, filePath);
}
