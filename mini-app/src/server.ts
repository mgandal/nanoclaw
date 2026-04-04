/**
 * Hermes Mini App — API Backend
 * 
 * Serves the static frontend and API endpoints for:
 *   Tab 1 (Command Center): /api/calendar, /api/tasks, /api/deadlines, /api/threads
 *   Tab 2 (Hermes):         /api/status, /api/cron, /api/memory
 * 
 * Runs as a standalone Bun server. Data sources:
 *   - Calendar: icalBuddy CLI
 *   - Tasks: Todoist API
 *   - Cron/Memory/Status: Hermes config files + process info
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.MINI_APP_PORT || '3456', 10);
const ICALBUDDY = '/opt/homebrew/bin/icalBuddy';
const HERMES_DIR = process.env.HERMES_DIR || path.join(process.env.HOME || '', '.hermes');
const TODOIST_API = 'https://todoist.com/api/v1';

// ── Todoist token ──
function getTodoistToken(): string {
  // Try env first
  if (process.env.TODOIST_API_TOKEN) return process.env.TODOIST_API_TOKEN;
  // Try nanoclaw .env
  try {
    const envPath = path.join(process.env.HOME || '', 'Agents', 'nanoclaw', '.env');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/TODOIST_API_TOKEN=(.+)/);
    if (match) return match[1].trim();
  } catch {}
  // Try hermes config
  try {
    const configPath = path.join(HERMES_DIR, 'config.yaml');
    const config = fs.readFileSync(configPath, 'utf-8');
    const match = config.match(/TODOIST_API_TOKEN[:\s]+['"]?([a-f0-9]+)['"]?/);
    if (match) return match[1];
  } catch {}
  return '';
}

// ── Calendar via icalBuddy ──
async function getCalendarEvents(): Promise<any[]> {
  try {
    const { stdout } = await execFileAsync(ICALBUDDY, [
      '-f', '-ea', '-nrd',
      '-npn',          // no property names
      '-b', '|||',     // bullet = block separator
      '-ps', '| ~~ |', // property separator
      '-po', 'title,datetime,location,calendarTitle',
      '-iep', 'title,datetime,location,calendarTitle', // only include these properties (excludes notes)
      '-df', '%Y-%m-%dT%H:%M:%S',
      '-tf', '%H:%M',
      '-ec', 'Birthdays,US Holidays,Siri Suggestions,Found in Natural Language',
      '-ic', 'MJG,Outlook,Gandal_Lab_Meetings,Gandal_Lab_Calendar',
      'eventsFrom:today', 'to:today+2',
    ]);
    
    // Strip ANSI color codes
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');

    const events: any[] = [];
    const blocks = clean.split('|||').filter(b => b.trim());

    for (const block of blocks) {
      const parts = block.split(' ~~ ').map(p => p.trim());
      if (parts.length < 2) continue;

      // icalBuddy appends calendar name to title: "Event Title (CalendarName)"
      let rawTitle = parts[0];
      let calendar = '';
      const calMatch = rawTitle.match(/\s+\((MJG|Outlook|Gandal_Lab_Meetings|Gandal_Lab_Calendar)\)$/);
      if (calMatch) {
        calendar = calMatch[1];
        rawTitle = rawTitle.slice(0, calMatch.index!);
      }
      const title = rawTitle;
      const datetimeStr = parts[1] || '';
      const location = parts[2] || '';

      // Parse datetime — icalBuddy outputs like "2026-04-02T10:00:00 at 10:00 - 11:00"
      let start = '';
      let allDay = false;

      // Strip " at HH:MM" suffix that icalBuddy appends when -tf is set
      let dtClean = datetimeStr.replace(/\s+at\s+\d{1,2}:\d{2}/g, '');
      
      if (dtClean.includes(' - ')) {
        start = dtClean.split(' - ')[0].trim();
      } else {
        start = dtClean.trim();
      }

      // All-day events: date-only format
      if (start.match(/^\d{4}-\d{2}-\d{2}$/) || !start.includes('T')) {
        allDay = true;
      }

      events.push({ title, start, allDay, location: location || undefined, calendar: calendar || undefined });
    }

    return events;
  } catch (err: any) {
    console.error('Calendar error:', err.message);
    return [];
  }
}

// ── Tasks via Todoist API ──
async function getTodoistTasks(): Promise<any[]> {
  const token = getTodoistToken();
  if (!token) return [];

  try {
    // Get tasks due today or overdue
    const resp = await fetch(`${TODOIST_API}/tasks?filter=${encodeURIComponent('today | overdue')}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Todoist ${resp.status}`);
    const data = await resp.json();
    // v1 API returns { results: [...] }
    const tasks = data.results || data || [];

    return tasks.map((t: any) => ({
      id: t.id,
      content: t.content,
      priority: 5 - t.priority, // Todoist uses 1=low, 4=urgent; we want 1=urgent
      due: t.due?.date || t.deadline?.date || null,
      section: t.section_id || null,
      labels: t.labels || [],
    })).sort((a: any, b: any) => a.priority - b.priority);
  } catch (err: any) {
    console.error('Todoist error:', err.message);
    return [];
  }
}

// ── Deadlines (from grants and known dates) ──
function getDeadlines(): any[] {
  // Static deadlines from AGENTS.md + any dynamic ones
  const deadlines = [
    { title: 'R01-MH121521 (iso-TWAS)', date: '2025-11-30' },
    { title: 'ITMAT Pilot (XRN2)', date: '2028-01-31' },
    { title: 'Lambertsen Lecture', date: '2026-05-11' },
  ];

  // Also check for any deadline files in hermes
  try {
    const dlPath = path.join(HERMES_DIR, 'deadlines.json');
    if (fs.existsSync(dlPath)) {
      const extra = JSON.parse(fs.readFileSync(dlPath, 'utf-8'));
      deadlines.push(...extra);
    }
  } catch {}

  // Sort by date, filter past
  const now = new Date();
  return deadlines
    .filter(d => new Date(d.date) >= new Date(now.toDateString()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ── Open Threads (email + Slack unreads) ──
async function getOpenThreads(): Promise<any[]> {
  // Placeholder — will integrate with gmail watcher and slack unreads
  // For now, return empty
  return [];
}

// ── Hermes System Status ──
function getSystemStatus(): any {
  const startTime = Date.now(); // Will be replaced with actual uptime tracking
  
  // Check nanoclaw process
  let health = 'down';
  let activeSessions = 0;
  let activeContainers = 0;

  try {
    // Read nanoclaw DB for session count
    const dbPath = path.join(process.env.HOME || '', 'Agents/nanoclaw/store/nanoclaw.db');
    if (fs.existsSync(dbPath)) {
      health = 'healthy';
    }
  } catch {}

  // Check hermes process
  try {
    const hermesLock = path.join(HERMES_DIR, '.lock');
    if (fs.existsSync(hermesLock)) {
      health = 'healthy';
    }
  } catch {}

  return {
    health: health === 'healthy' ? '' : 'down',
    uptime: '—', // Will integrate with actual process tracking
    activeSessions,
    activeContainers,
    messagesLast24h: 0,
  };
}

// ── Cron Jobs ──
async function getCronJobs(): Promise<any[]> {
  try {
    const jobsFile = path.join(HERMES_DIR, 'cron', 'jobs.json');
    if (!fs.existsSync(jobsFile)) return [];

    const data = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    const jobsList = data.jobs || [];

    return jobsList.map((j: any) => ({
      id: j.id || '',
      name: j.name || j.id || '',
      schedule: j.schedule_display || j.schedule?.display || '',
      paused: j.state === 'paused' || !!j.paused_at,
      nextRun: j.next_run_at || null,
      lastRun: j.last_run_at || null,
      lastStatus: j.last_status || null,
      enabled: j.enabled !== false,
    })).filter((j: any) => j.enabled);
  } catch {
    return [];
  }
}

// ── Memory Stats ──
function getMemoryStats(): any {
  const result: any = {};

  try {
    const memPath = path.join(HERMES_DIR, 'memories', 'MEMORY.md');
    if (fs.existsSync(memPath)) {
      const content = fs.readFileSync(memPath, 'utf-8');
      const totalLimit = 2200;
      result.memory = {
        used: content.length,
        total: totalLimit,
        pct: Math.round((content.length / totalLimit) * 100),
      };

      // Extract recent entries (split by §)
      const entries = content.split('§').map(e => e.trim()).filter(Boolean);
      result.entries = entries.slice(-5); // Last 5
    }
  } catch {}

  try {
    const userPath = path.join(HERMES_DIR, 'memories', 'USER.md');
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf-8');
      const totalLimit = 1375;
      result.user = {
        used: content.length,
        total: totalLimit,
        pct: Math.round((content.length / totalLimit) * 100),
      };
    }
  } catch {}

  return result;
}

// ── Bun HTTP Server ──
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS headers for dev
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-Telegram-Init-Data, Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── API Routes ──
    if (pathname === '/api/calendar') {
      const events = await getCalendarEvents();
      return Response.json({ events }, { headers: corsHeaders });
    }

    if (pathname === '/api/tasks') {
      const tasks = await getTodoistTasks();
      return Response.json({ tasks }, { headers: corsHeaders });
    }

    if (pathname === '/api/deadlines') {
      const deadlines = getDeadlines();
      return Response.json({ deadlines }, { headers: corsHeaders });
    }

    if (pathname === '/api/threads') {
      const threads = await getOpenThreads();
      return Response.json({ threads }, { headers: corsHeaders });
    }

    if (pathname === '/api/status') {
      const status = getSystemStatus();
      return Response.json(status, { headers: corsHeaders });
    }

    if (pathname === '/api/cron') {
      const jobs = await getCronJobs();
      return Response.json({ jobs }, { headers: corsHeaders });
    }

    if (pathname === '/api/memory') {
      const memory = getMemoryStats();
      return Response.json(memory, { headers: corsHeaders });
    }

    // ── Static Files ──
    const publicDir = path.join(import.meta.dir, '..', 'public');
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(publicDir, filePath);

    // Security: prevent path traversal
    if (!fullPath.startsWith(publicDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            ...corsHeaders,
            'Content-Type': getContentType(filePath),
            'Cache-Control': 'no-cache',
          },
        });
      }
    } catch {}

    return new Response('Not Found', { status: 404 });
  },
});

function getContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

console.log(`🦞 Hermes Mini App running on http://localhost:${PORT}`);
