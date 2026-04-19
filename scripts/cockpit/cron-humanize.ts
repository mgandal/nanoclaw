import { CronExpressionParser } from 'cron-parser';

/**
 * Convert a 5-field POSIX cron string to a human-readable description.
 * Returns the raw string unchanged if parsing fails (one known row in
 * scheduled_tasks has a malformed 7-token value).
 */
export function humanizeCron(raw: string): string {
  try {
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 5) return raw;

    const [minute, hour, dom, month, dow] = parts;
    CronExpressionParser.parse(raw);

    const dowDesc = describeDow(dow);
    const hourDesc = describeTime(hour, minute);
    const domDesc = dom === '*' ? '' : ` on day ${dom}`;
    const monthDesc = month === '*' ? '' : ` in month ${month}`;

    return [hourDesc, dowDesc, domDesc, monthDesc].filter(Boolean).join(' ');
  } catch {
    return raw;
  }
}

function describeDow(dow: string): string {
  if (dow === '*') return 'every day';
  if (dow === '1-5') return 'weekdays';
  if (dow === '0,6' || dow === '6,0') return 'weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const singleNum = /^\d$/.test(dow);
  if (singleNum) return `on ${names[parseInt(dow, 10)] ?? dow}`;
  return `on days ${dow}`;
}

function describeTime(hour: string, minute: string): string {
  if (hour === '*' && minute === '*') return 'every minute';
  if (hour === '*') return `at :${minute.padStart(2, '0')} past every hour`;
  if (hour.startsWith('*/')) return `every ${hour.slice(2)}h`;
  if (hour.includes(',')) return `at hours ${hour}`;
  const hh = hour.padStart(2, '0');
  const mm = (minute === '*' ? '00' : minute).padStart(2, '0');
  return `at ${hh}:${mm}`;
}
