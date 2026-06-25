#!/usr/bin/env python3
"""
Follow-up Hub generator + here.now publisher.

Replaces the broken GitHub-gist read path (expired token -> stale hub) with
data inlined directly into the page, hosted on here.now at a STABLE slug.
The ntfy.sh write-back (Mike checks items -> agent polls topic) is preserved
verbatim.

Read source : /workspace/global/state/followups.md  (managed by email-ingest.py)
Write target: here.now site (PUT to existing slug -> stable URL)

Usage:
  python3 followup-hub-publish.py            # parse + publish (update existing slug)
  python3 followup-hub-publish.py --dry-run  # write HTML to /tmp, no publish
  python3 followup-hub-publish.py --apply     # drain ntfy submissions -> mark done -> republish

Paths default to the in-container mount but can be overridden via env
(FOLLOWUPS_PATH / HUB_STATE_PATH / RELAY_STATE_PATH) so the host-side poller
can drive the same code against the host filesystem.
"""
import json, re, sys, hashlib, os, datetime, urllib.request, urllib.error

FOLLOWUPS = os.environ.get("FOLLOWUPS_PATH", "/workspace/global/state/followups.md")
STATE     = os.environ.get("HUB_STATE_PATH", "/workspace/global/state/followup-hub-state.json")  # {slug, siteUrl}
# Last ntfy message id the --apply path has already processed (host poller also tracks its own).
RELAY_STATE = os.environ.get("RELAY_STATE_PATH", "/workspace/global/state/relay-last-id.txt")
RELAY_TOPIC = "nanoclaw-relay-7406c450"
API = "https://here.now"

# Shared id + write-back logic lives in email_ingest.followups so the page
# generator and the matcher can never drift. Fall back to a local copy of the
# id formula if that module isn't importable (e.g. minimal container env) — but
# --apply (which needs mark_done_by_ids) hard-requires the import.
try:
    _SYNC = os.environ.get("EMAIL_INGEST_PATH")
    if _SYNC and _SYNC not in sys.path:
        sys.path.insert(0, _SYNC)
    from email_ingest.followups import hub_id as _hub_id, mark_done_by_ids as _mark_done_by_ids
    _HAVE_INGEST = True
except Exception:
    _HAVE_INGEST = False
    def _hub_id(date, who, what):
        return "f-" + hashlib.sha1((date + who + what).encode()).hexdigest()[:10]
    _mark_done_by_ids = None

def load_key():
    # home dir does NOT persist across containers; prefer workspace-pinned key
    for p in [os.path.expanduser("~/.herenow/credentials"),
              "/workspace/global/state/.herenow-key"]:
        if os.path.exists(p):
            k = open(p).read().strip()
            if k:
                return k
    k = os.environ.get("HERENOW_API_KEY", "").strip()
    if k:
        return k
    sys.exit("ERROR: no here.now API key found")

# ---------- parse followups.md ----------
def parse_open_followups(path):
    txt = open(path, encoding="utf-8").read()
    # isolate the ## Open section (until next ## heading)
    m = re.search(r"\n##\s+Open\s*\n(.*?)(?=\n##\s+\S)", txt, re.S)
    body = m.group(1) if m else txt
    recs = []
    # each record begins with "### <date> · <type> · <who>"
    blocks = re.split(r"\n(?=###\s)", body)
    today = datetime.date.today()
    for b in blocks:
        head = re.match(r"###\s+(\d{4}-\d{2}-\d{2})\s+·\s+([^\s·]+)\s+·\s+(.+)", b)
        if not head:
            continue
        date, ftype, who = head.group(1), head.group(2).strip(), head.group(3).strip()
        def field(name):
            fm = re.search(r"-\s+\*\*"+name+r":\*\*\s*(.+)", b)
            return fm.group(1).strip() if fm else ""
        status = field("status").lower()
        if status != "open":
            continue
        what = field("what")
        due  = field("due")
        who_clean = re.sub(r"\s*<[^>]+>", "", who).strip()  # strip <email>
        past = False
        due_date = ""
        if due and due.lower() != "none":
            due_date = due
            try:
                past = datetime.date.fromisoformat(due[:10]) < today
            except ValueError:
                past = False
        rid = _hub_id(date, who, what)
        recs.append({
            "id": rid,
            "label": what or f"(follow-up with {who_clean})",
            "source": who_clean,
            "date": date,
            "type": ftype,
            "due_date": due_date,
            "past": past,
        })
    # overdue first, then by date desc
    recs.sort(key=lambda r: (not r["past"], r["date"]), reverse=False)
    recs.sort(key=lambda r: r["past"], reverse=True)
    return recs

# ---------- build HTML ----------
def build_html(followups):
    data = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(),
        "followups": followups,
        "todos": [],
        "decisions": [],
    }
    data_json = json.dumps(data, ensure_ascii=False)
    return HTML_TEMPLATE.replace("/*__INLINE_DATA__*/null", data_json)

# ---------- here.now publish (3-step, stable slug) ----------
def http(method, url, key, body=None, headers=None):
    h = {"Authorization": f"Bearer {key}"}
    if headers: h.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def put_file(url, headers, content):
    req = urllib.request.Request(url, data=content, method="PUT", headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status

def publish(html, key):
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    slug = state.get("slug")
    body_bytes = html.encode()
    files = [{
        "path": "index.html",
        "size": len(body_bytes),
        "contentType": "text/html; charset=utf-8",
        "hash": hashlib.sha256(body_bytes).hexdigest(),
    }]
    payload = {
        "files": files,
        "displayName": "Follow-up Hub",
        "displayDescription": "Mike's daily follow-ups — check off done items",
    }
    if slug:
        status, resp = http("PUT", f"{API}/api/v1/publish/{slug}", key, payload)
        if status in (404, 410):  # slug gone -> recreate
            slug = None
    if not slug:
        status, resp = http("POST", f"{API}/api/v1/publish", key, payload)
    if status >= 400:
        sys.exit(f"publish create failed {status}: {resp}")
    slug = resp["slug"]
    site_url = resp["siteUrl"]
    up = resp["upload"]
    version_id = up["versionId"]
    for t in up.get("uploads", []):
        if t["path"] == "index.html":
            put_file(t["url"], t["headers"], body_bytes)
    # finalize
    fstatus, fresp = http("POST", f"{API}/api/v1/publish/{slug}/finalize", key,
                          {"versionId": version_id})
    if fstatus >= 400:
        sys.exit(f"finalize failed {fstatus}: {fresp}")
    json.dump({"slug": slug, "siteUrl": site_url}, open(STATE, "w"))
    return site_url, len(up.get("uploads", [])), up.get("skipped", [])

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Follow-up Hub</title>
  <style>
    :root {
      --bg: #0f0f13; --surface: #1a1a24; --border: #2a2a3a;
      --accent: #6c63ff; --accent2: #ff6584; --text: #e8e8f0; --muted: #888;
      --green: #4caf50; --orange: #ff9800; --red: #f44336;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: 80px; }
    header { background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 14px 16px 0; position: sticky; top: 0; z-index: 10; }
    header h1 { font-size: 16px; font-weight: 600; margin-bottom: 10px; color: var(--accent); }
    .generated { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
    .tabs { display: flex; gap: 4px; }
    .tab { padding: 8px 14px; border-radius: 6px 6px 0 0; font-size: 13px;
      cursor: pointer; color: var(--muted); border: none; background: transparent;
      transition: color .15s, background .15s; }
    .tab.active { background: var(--bg); color: var(--text); font-weight: 600; }
    .tab .badge { display: inline-block; background: var(--accent); color: white;
      border-radius: 10px; font-size: 10px; padding: 1px 6px; margin-left: 4px; }
    .panel { display: none; padding: 12px 16px; }
    .panel.active { display: block; }
    .item { display: flex; align-items: flex-start; gap: 12px; padding: 12px; margin-bottom: 8px;
      background: var(--surface); border-radius: 8px; border: 1px solid var(--border); cursor: pointer;
      transition: border-color .15s, opacity .2s; -webkit-tap-highlight-color: transparent; }
    .item:active { opacity: 0.75; }
    .item.checked { opacity: 0.5; border-color: var(--green); }
    .item.checked .label { text-decoration: line-through; color: var(--muted); }
    .checkbox { width: 20px; height: 20px; min-width: 20px; border-radius: 50%;
      border: 2px solid var(--border); display: flex; align-items: center;
      justify-content: center; transition: border-color .15s, background .15s; margin-top: 1px; }
    .item.checked .checkbox { background: var(--green); border-color: var(--green); }
    .checkbox svg { display: none; }
    .item.checked .checkbox svg { display: block; }
    .content { flex: 1; min-width: 0; }
    .label { font-size: 14px; line-height: 1.4; }
    .meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; }
    .tag { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .tag.past { background: rgba(244,67,54,.15); color: var(--red); }
    .tag.p4 { background: rgba(244,67,54,.15); color: var(--red); }
    .tag.p3 { background: rgba(255,152,0,.15); color: var(--orange); }
    .tag.p2 { background: rgba(108,99,255,.15); color: var(--accent); }
    .tag.type { background: rgba(255,101,132,.1); color: var(--accent2); }
    .empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
    .footer, footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 16px;
      background: var(--surface); border-top: 1px solid var(--border); }
    .submit-btn { width: 100%; padding: 14px; background: var(--accent); color: white; border: none;
      border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer;
      transition: opacity .15s, transform .1s; }
    .submit-btn:disabled { opacity: 0.4; cursor: default; }
    .submit-btn:active:not(:disabled) { transform: scale(0.98); }
    .submit-btn.success { background: var(--green); }
    .submit-btn.error { background: var(--red); }
    #test-panel { display: none; padding: 12px 16px; font-size: 11px; font-family: monospace; }
    #test-panel.visible { display: block; }
    .test-result { padding: 3px 0; }
    .test-result.pass { color: #4caf50; }
    .test-result.fail { color: var(--red); }
  </style>
</head>
<body>

<header id="app-header">
  <h1>⚡ Follow-up Hub</h1>
  <div class="generated" id="gen-time"></div>
  <div class="tabs">
    <button class="tab active" data-tab="followups">Followups <span class="badge" id="b-followups">0</span></button>
    <button class="tab" data-tab="todos">Todos <span class="badge" id="b-todos">0</span></button>
    <button class="tab" data-tab="decisions">Decisions <span class="badge" id="b-decisions">0</span></button>
  </div>
</header>

<main id="app-main">
  <div class="panel active" id="panel-followups"></div>
  <div class="panel" id="panel-todos"></div>
  <div class="panel" id="panel-decisions"></div>
</main>

<footer id="app-footer">
  <button class="submit-btn" id="submit-btn" disabled>
    Mark <span id="checked-count">0</span> done
  </button>
</footer>

<div id="test-panel">
  <strong style="color:var(--accent)">TDD Tests</strong><br>
  <div id="test-results"></div>
</div>

<script>
// Relay via ntfy.sh — no auth required; agent polls this topic every 30 min
const RELAY_TOPIC = 'nanoclaw-relay-7406c450';
const RELAY_URL = `https://ntfy.sh/${RELAY_TOPIC}`;
// Data is inlined at publish time (no external fetch — eliminates the broken gist token)
const allData = /*__INLINE_DATA__*/null;

const checked = new Map();

function buildRelayPayload() {
  return { processed: false, submitted_at: new Date().toISOString(), items: Array.from(checked.values()) };
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderItem(item, type) {
  const id = item.id;
  const el = document.createElement('div');
  el.className = 'item'; el.dataset.id = id;
  const tags = [];
  if (item.past) tags.push(`<span class="tag past">overdue</span>`);
  if (item.priority) { const p = item.priority.toLowerCase(); tags.push(`<span class="tag ${p}">${item.priority}</span>`); }
  if (item.type && item.type !== 'they-owe-me') tags.push(`<span class="tag type">${escHtml(item.type)}</span>`);
  const meta = [];
  if (item.source) meta.push(`from ${item.source}`);
  if (item.date) meta.push(item.date);
  if (item.due_date) meta.push(`due ${item.due_date}`);
  el.innerHTML = `
    <div class="checkbox">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="content">
      <div class="label">${escHtml(item.label)}</div>
      <div class="meta">${tags.join('')}${meta.map(m => `<span>${escHtml(m)}</span>`).join(' · ')}</div>
    </div>`;
  el.addEventListener('click', () => toggle(el, id, { ...item, type, itemType: type }));
  return el;
}

function toggle(el, id, meta) {
  if (checked.has(id)) { checked.delete(id); el.classList.remove('checked'); }
  else { checked.set(id, meta); el.classList.add('checked'); }
  updateSubmitBtn();
}

function updateSubmitBtn() {
  const n = checked.size;
  const btn = document.getElementById('submit-btn');
  document.getElementById('checked-count').textContent = n;
  btn.disabled = n === 0;
}

function renderPanel(panelId, items, type) {
  const panel = document.getElementById(panelId);
  panel.innerHTML = '';
  if (!items || items.length === 0) { panel.innerHTML = `<div class="empty">Nothing here ✓</div>`; return; }
  items.forEach(item => panel.appendChild(renderItem(item, type)));
}

async function submit() {
  const btn = document.getElementById('submit-btn');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Submitting…';
  const payload = buildRelayPayload();
  try {
    const res = await fetch(RELAY_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
    btn.classList.add('success');
    btn.textContent = `✓ Submitted ${payload.items.length} item${payload.items.length !== 1 ? 's' : ''} — processed in ~30 min`;
    setTimeout(() => {
      checked.clear();
      document.querySelectorAll('.item.checked').forEach(el => el.classList.remove('checked'));
      updateSubmitBtn(); btn.classList.remove('success'); btn.textContent = 'Mark 0 done';
    }, 4000);
  } catch(e) {
    btn.classList.add('error'); btn.textContent = `Error: ${e.message}`; btn.disabled = false;
    setTimeout(() => { btn.classList.remove('error'); updateSubmitBtn(); }, 3000);
  }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const t = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${t}`).classList.add('active');
  });
});
document.getElementById('submit-btn').addEventListener('click', submit);

async function runTests() {
  const results = [];
  const assert = (name, cond, info='') => results.push({ name, pass: !!cond, info });
  assert('T1: Page loaded (no SSO redirect)', true);
  assert('T2: Inline data present', !!allData, typeof allData);
  assert('T3: Data is object', allData && typeof allData === 'object');
  assert('T4: Has followups array', Array.isArray(allData?.followups), `len=${allData?.followups?.length}`);
  assert('T5: Has todos array', Array.isArray(allData?.todos));
  assert('T6: Has decisions array', Array.isArray(allData?.decisions));
  assert('T7: followup has required fields', allData?.followups?.[0] &&
    ['id','label','source','date'].every(k => k in allData.followups[0]),
    JSON.stringify(Object.keys(allData?.followups?.[0] ?? {})));
  const fake = { id: 'f-test', type: 'followup', line: 5 };
  checked.set('f-test', fake);
  const payload = buildRelayPayload();
  assert('T8: Relay payload has processed=false', payload.processed === false);
  assert('T9: Relay payload items is array', Array.isArray(payload.items));
  assert('T10: Relay item preserved', payload.items[0]?.id === 'f-test');
  checked.clear();
  try {
    const r = await fetch(RELAY_URL, { method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Tags': 'test' },
      body: JSON.stringify({ processed: false, test: true, items: [] }) });
    assert('T11: ntfy.sh relay accepts POST', r.ok, `status=${r.status}`);
  } catch(e) { assert('T11: ntfy.sh relay accepts POST', false, e.message); }
  return results;
}

function init() {
  const showTest = new URLSearchParams(location.search).get('test') === '1';
  const ts = allData.generated_at;
  document.getElementById('gen-time').textContent = ts
    ? `Updated ${new Date(ts).toLocaleString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`
    : '';
  renderPanel('panel-followups', allData.followups, 'followup');
  renderPanel('panel-todos', allData.todos, 'todo');
  renderPanel('panel-decisions', allData.decisions, 'decision');
  document.getElementById('b-followups').textContent = (allData.followups||[]).length;
  document.getElementById('b-todos').textContent = (allData.todos||[]).length;
  document.getElementById('b-decisions').textContent = (allData.decisions||[]).length;
  if (showTest) {
    (async () => {
      const tp = document.getElementById('test-panel'); tp.classList.add('visible');
      const results = await runTests();
      const c = document.getElementById('test-results'); let pass=0, fail=0;
      results.forEach(r => {
        const d = document.createElement('div'); d.className = `test-result ${r.pass?'pass':'fail'}`;
        d.textContent = `${r.pass?'✓':'✗'} ${r.name}${r.info?' ['+r.info+']':''}`;
        c.appendChild(d); r.pass?pass++:fail++;
      });
      const s = document.createElement('div'); s.style.cssText='margin-top:8px;font-weight:bold;';
      s.style.color = fail===0?'#4caf50':'#f44336'; s.textContent = `${pass}/${results.length} passed`;
      c.appendChild(s);
    })();
  }
}
init();
</script>
</body>
</html>
"""

# ---------- apply: drain ntfy submissions -> mark done -> republish ----------
def _read_relay_last():
    try:
        return open(RELAY_STATE).read().strip() or "all"
    except OSError:
        return "all"

def _write_relay_last(mid):
    try:
        os.makedirs(os.path.dirname(RELAY_STATE), exist_ok=True)
        open(RELAY_STATE, "w").write(mid)
    except OSError as e:
        print(f"WARN: could not persist relay state: {e}", file=sys.stderr)

def fetch_submissions(since):
    """Poll ntfy once. Returns (messages, latest_id). Each message is the parsed
    submission dict; latest_id is the newest ntfy message id seen (or `since`)."""
    url = f"https://ntfy.sh/{RELAY_TOPIC}/json?poll=1&since={since}"
    req = urllib.request.Request(url, headers={"User-Agent": "followup-hub/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
    subs, latest = [], since
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            env = json.loads(line)
        except json.JSONDecodeError:
            continue
        if env.get("event") != "message":
            continue
        latest = env.get("id", latest)
        try:
            body = json.loads(env.get("message", "") or "{}")
        except json.JSONDecodeError:
            continue
        if body.get("test") or body.get("processed"):
            continue
        subs.append(body)
    return subs, latest

def apply_submissions(key):
    """Process any new ntfy submissions: flip checked follow-ups to done and
    republish so the live page reflects it. Returns list of marked labels."""
    if not _HAVE_INGEST or _mark_done_by_ids is None:
        sys.exit("ERROR: --apply requires email_ingest.followups (set EMAIL_INGEST_PATH)")
    since = _read_relay_last()
    subs, latest = fetch_submissions(since)
    # Collect followup ids across all new submissions (todos/decisions ignored here).
    want_ids, labels = [], {}
    for body in subs:
        for it in body.get("items", []):
            if (it.get("itemType") or it.get("type")) == "followup" and it.get("id"):
                want_ids.append(it["id"])
                labels[it["id"]] = it.get("label", it["id"])
    if not want_ids:
        # Still advance the cursor so we don't re-scan the same window forever.
        if latest != since:
            _write_relay_last(latest)
        print("no new follow-up submissions")
        return []
    marked = _mark_done_by_ids(FOLLOWUPS, want_ids)
    _write_relay_last(latest)
    if marked:
        followups = parse_open_followups(FOLLOWUPS)
        html = build_html(followups)
        url, _, _ = publish(html, key)
        print(f"marked {len(marked)} done; republished {url}")
    else:
        print(f"submissions had {len(want_ids)} ids but none were open (already done?)")
    return [labels.get(mid, mid) for mid in marked]

def main():
    dry = "--dry-run" in sys.argv
    if "--apply" in sys.argv:
        key = load_key()
        out = apply_submissions(key)
        # Machine-readable trailer so a caller (host poller / agent) can report.
        print("MARKED_JSON=" + json.dumps(out))
        return
    followups = parse_open_followups(FOLLOWUPS)
    html = build_html(followups)
    open("/tmp/followup-hub.html", "w", encoding="utf-8").write(html)
    print(f"parsed {len(followups)} open follow-ups; html={len(html)} bytes -> /tmp/followup-hub.html")
    if dry:
        return
    key = load_key()
    url, uploaded, skipped = publish(html, key)
    print(f"PUBLISHED {url}  (uploaded={uploaded} skipped={skipped})")

if __name__ == "__main__":
    main()
