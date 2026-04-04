// Hermes Mini App — Telegram Web App
const tg = window.Telegram?.WebApp;
const API_BASE = window.location.origin + '/api';

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  // Telegram SDK setup
  if (tg) {
    tg.ready();
    tg.expand();
    tg.enableClosingConfirmation();
    // Apply Telegram theme
    document.body.style.backgroundColor = tg.themeParams.bg_color || '';
    document.body.style.color = tg.themeParams.text_color || '';
  }

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Initial data load
  loadCommandCenter();
});

// ── Tab Switching ──
function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(tabId).classList.add('active');

  if (tg) tg.HapticFeedback.selectionChanged();

  if (tabId === 'command-center') loadCommandCenter();
  if (tabId === 'hermes') loadHermes();
}

// ── API Fetch Helper ──
async function apiFetch(endpoint) {
  const headers = {};
  if (tg?.initData) {
    headers['X-Telegram-Init-Data'] = tg.initData;
  }
  const resp = await fetch(`${API_BASE}${endpoint}`, { headers });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ── Formatters ──
function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function daysUntil(isoStr) {
  if (!isoStr) return null;
  const now = new Date();
  const target = new Date(isoStr);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

// ── Command Center Tab ──
async function loadCommandCenter() {
  await Promise.allSettled([
    loadCalendar(),
    loadTasks(),
    loadDeadlines(),
    loadThreads(),
  ]);
}

async function loadCalendar() {
  const container = document.getElementById('calendar-list');
  const badge = document.getElementById('calendar-count');
  try {
    const data = await apiFetch('/calendar');
    const events = data.events || [];
    badge.textContent = events.length;
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state">No events today</div>';
      return;
    }

    // Group by date
    const grouped = {};
    events.forEach(ev => {
      const dateKey = formatDate(ev.start);
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(ev);
    });

    let html = '';
    for (const [date, evts] of Object.entries(grouped)) {
      if (Object.keys(grouped).length > 1) {
        html += `<div class="event-meta" style="padding: 8px 0 4px; font-weight: 600; color: var(--accent)">${date}</div>`;
      }
      evts.forEach(ev => {
        const allDay = ev.allDay;
        const time = allDay ? 'All day' : formatTime(ev.start);
        html += `
          <div class="event-item">
            <span class="event-time">${time}</span>
            <div>
              <div class="event-title">${esc(ev.title)}</div>
              ${ev.location ? `<div class="event-meta">📍 ${esc(ev.location)}</div>` : ''}
              ${ev.calendar ? `<div class="event-meta">${esc(ev.calendar)}</div>` : ''}
            </div>
          </div>`;
      });
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load calendar<br><button class="retry-btn" onclick="loadCalendar()">Retry</button></div>`;
  }
}

async function loadTasks() {
  const container = document.getElementById('tasks-list');
  const badge = document.getElementById('tasks-count');
  try {
    const data = await apiFetch('/tasks');
    const tasks = data.tasks || [];
    badge.textContent = tasks.length;
    if (tasks.length === 0) {
      container.innerHTML = '<div class="empty-state">All clear ✨</div>';
      return;
    }

    container.innerHTML = tasks.map(t => {
      const pClass = `p${t.priority || 4}`;
      const due = t.due ? formatDate(t.due) : '';
      const d = t.due ? daysUntil(t.due) : null;
      const overdue = d !== null && d < 0;
      return `
        <div class="task-item">
          <span class="task-priority ${pClass}"></span>
          <div>
            <div class="task-text">${esc(t.content)}</div>
            ${due ? `<div class="task-due ${overdue ? 'overdue' : ''}">${overdue ? '⚠️ Overdue — ' : ''}${due}</div>` : ''}
            ${t.section ? `<div class="task-due">${esc(t.section)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load tasks<br><button class="retry-btn" onclick="loadTasks()">Retry</button></div>`;
  }
}

async function loadDeadlines() {
  const container = document.getElementById('deadlines-list');
  try {
    const data = await apiFetch('/deadlines');
    const deadlines = data.deadlines || [];
    if (deadlines.length === 0) {
      container.innerHTML = '<div class="empty-state">No upcoming deadlines</div>';
      return;
    }

    container.innerHTML = deadlines.map(dl => {
      const d = daysUntil(dl.date);
      let urgency = 'ok';
      let label = `${d}d`;
      if (d !== null) {
        if (d <= 0) { urgency = 'urgent'; label = d === 0 ? 'TODAY' : `${Math.abs(d)}d overdue`; }
        else if (d <= 7) { urgency = 'urgent'; }
        else if (d <= 30) { urgency = 'soon'; }
      }
      return `
        <div class="deadline-item">
          <div>
            <div class="deadline-label">${esc(dl.title)}</div>
            <div class="deadline-date">${formatDate(dl.date)}</div>
          </div>
          <span class="deadline-days ${urgency}">${label}</span>
        </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load deadlines<br><button class="retry-btn" onclick="loadDeadlines()">Retry</button></div>`;
  }
}

async function loadThreads() {
  const container = document.getElementById('threads-list');
  const badge = document.getElementById('threads-count');
  try {
    const data = await apiFetch('/threads');
    const threads = data.threads || [];
    badge.textContent = threads.length;
    if (threads.length === 0) {
      container.innerHTML = '<div class="empty-state">Inbox zero 🎉</div>';
      return;
    }

    container.innerHTML = threads.map(t => `
      <div class="thread-item">
        <div class="thread-source">${esc(t.source || 'email')}</div>
        <div class="thread-subject">${esc(t.subject)}</div>
        ${t.preview ? `<div class="thread-preview">${esc(t.preview)}</div>` : ''}
        <div class="thread-age">${timeAgo(t.timestamp)}</div>
      </div>`
    ).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load threads<br><button class="retry-btn" onclick="loadThreads()">Retry</button></div>`;
  }
}

// ── Hermes Tab ──
async function loadHermes() {
  await Promise.allSettled([
    loadSystemStatus(),
    loadCronJobs(),
    loadMemory(),
  ]);
}

async function loadSystemStatus() {
  const container = document.getElementById('status-body');
  const dot = document.getElementById('system-health');
  try {
    const data = await apiFetch('/status');
    dot.className = 'status-dot ' + (data.health || 'down');

    container.innerHTML = `
      <div class="status-grid">
        <div class="status-item">
          <div class="status-label">Uptime</div>
          <div class="status-value">${esc(data.uptime || '—')}</div>
        </div>
        <div class="status-item">
          <div class="status-label">Sessions</div>
          <div class="status-value">${data.activeSessions ?? '—'}</div>
        </div>
        <div class="status-item">
          <div class="status-label">Containers</div>
          <div class="status-value">${data.activeContainers ?? '—'}</div>
        </div>
        <div class="status-item">
          <div class="status-label">Messages/24h</div>
          <div class="status-value">${data.messagesLast24h ?? '—'}</div>
        </div>
      </div>
      ${data.lastError ? `<div class="event-meta" style="margin-top: 8px; color: var(--danger)">Last error: ${esc(data.lastError)}</div>` : ''}
    `;
  } catch (err) {
    dot.className = 'status-dot down';
    container.innerHTML = `<div class="error-state">Cannot reach Hermes<br><button class="retry-btn" onclick="loadSystemStatus()">Retry</button></div>`;
  }
}

async function loadCronJobs() {
  const container = document.getElementById('cron-list');
  const badge = document.getElementById('cron-count');
  try {
    const data = await apiFetch('/cron');
    const jobs = data.jobs || [];
    badge.textContent = jobs.length;
    if (jobs.length === 0) {
      container.innerHTML = '<div class="empty-state">No scheduled jobs</div>';
      return;
    }

    container.innerHTML = jobs.map(j => {
      const statusClass = j.paused ? 'paused' : 'active';
      const statusLabel = j.paused ? 'Paused' : 'Active';
      return `
        <div class="cron-item">
          <div class="cron-header">
            <span class="cron-name">${esc(j.name || j.id)}</span>
            <span class="cron-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="cron-schedule">${esc(j.schedule || '')}</div>
          ${j.nextRun ? `<div class="cron-next">Next: ${formatDate(j.nextRun)} ${formatTime(j.nextRun)}</div>` : ''}
        </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load cron jobs<br><button class="retry-btn" onclick="loadCronJobs()">Retry</button></div>`;
  }
}

async function loadMemory() {
  const container = document.getElementById('memory-body');
  try {
    const data = await apiFetch('/memory');

    let html = '';

    // Memory store
    if (data.memory) {
      const m = data.memory;
      html += `
        <div class="memory-store">
          <div class="memory-store-title">📝 Notes</div>
          <div class="memory-usage">
            <div class="memory-bar">
              <div class="memory-bar-fill ${m.pct > 90 ? 'full' : m.pct > 75 ? 'high' : ''}" style="width: ${m.pct}%"></div>
            </div>
            <span class="memory-pct">${m.pct}%</span>
          </div>
          <div class="event-meta" style="margin-top: 4px">${m.used} / ${m.total} chars</div>
        </div>`;
    }

    // User profile
    if (data.user) {
      const u = data.user;
      html += `
        <div class="memory-store">
          <div class="memory-store-title">👤 User Profile</div>
          <div class="memory-usage">
            <div class="memory-bar">
              <div class="memory-bar-fill ${u.pct > 90 ? 'full' : u.pct > 75 ? 'high' : ''}" style="width: ${u.pct}%"></div>
            </div>
            <span class="memory-pct">${u.pct}%</span>
          </div>
          <div class="event-meta" style="margin-top: 4px">${u.used} / ${u.total} chars</div>
        </div>`;
    }

    // Recent entries
    if (data.entries && data.entries.length > 0) {
      html += `
        <div class="memory-store">
          <div class="memory-store-title">Recent Entries</div>
          ${data.entries.map(e => `<div class="memory-entry">${esc(e)}</div>`).join('')}
        </div>`;
    }

    container.innerHTML = html || '<div class="empty-state">No memory data</div>';
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load memory<br><button class="retry-btn" onclick="loadMemory()">Retry</button></div>`;
  }
}

// ── Util ──
function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
