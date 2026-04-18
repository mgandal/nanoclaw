export interface QuietConfig {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  daysOff: string[]; // e.g. ["Sat","Sun"]
  timezone: string;
}

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return { h, m };
}

function localParts(
  d: Date,
  tz: string,
): { day: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let day = '',
    hour = 0,
    minute = 0;
  for (const p of fmt.formatToParts(d)) {
    if (p.type === 'weekday') day = p.value;
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return { day, hour, minute };
}

export function isInQuietHours(now: Date, cfg: QuietConfig): boolean {
  const { day, hour, minute } = localParts(now, cfg.timezone);
  if (cfg.daysOff.includes(day)) return true;
  const s = parseHHMM(cfg.start),
    e = parseHHMM(cfg.end);
  const cur = hour * 60 + minute;
  const sMin = s.h * 60 + s.m,
    eMin = e.h * 60 + e.m;
  if (sMin === eMin) return true; // 24-hour quiet (start == end)
  if (sMin > eMin) return cur >= sMin || cur < eMin; // wraps midnight
  return cur >= sMin && cur < eMin;
}

function offsetMin(utc: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(utc).map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) % 24,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );
  return (local - utc.getTime()) / 60_000;
}

function advanceLocalDay(current: Date, tz: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(current);
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10));
  // Anchor to noon UTC of the NEXT day — won't collide with any DST transition.
  return new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
}

export function nextQuietEnd(now: Date, cfg: QuietConfig): Date {
  const e = parseHHMM(cfg.end);
  let candidate = new Date(now.getTime());
  for (let i = 0; i < 14; i++) {
    const { day } = localParts(candidate, cfg.timezone);
    if (!cfg.daysOff.includes(day)) {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: cfg.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(candidate);
      // Parse as UTC (trailing Z) so the result is host-TZ-independent.
      // offsetMin(naive, tz) returns the tz's offset relative to UTC at that
      // wall-clock moment (e.g. -240 for EDT). Subtracting it translates the
      // would-be-UTC instant back to the real UTC instant.
      const naive = new Date(
        `${ymd}T${String(e.h).padStart(2, '0')}:${String(e.m).padStart(2, '0')}:00Z`,
      );
      const utc = new Date(
        naive.getTime() - offsetMin(naive, cfg.timezone) * 60_000,
      );
      if (utc.getTime() > now.getTime()) return utc;
    }
    candidate = advanceLocalDay(candidate, cfg.timezone);
  }
  throw new Error('nextQuietEnd: no eligible day in 14d window');
}
