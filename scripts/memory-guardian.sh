#!/bin/bash
# Weekly memory integrity check
# Runs integrity_checker.py and posts results to CLAIRE via IPC
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON3="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"
CHECKER="$PROJECT_DIR/groups/telegram_claire/memory_guardian/integrity_checker.py"
IPC_DIR="$PROJECT_DIR/data/ipc/telegram_claire/messages"
CLAIRE_JID="tg:8475020901"

# Point integrity checker at host-side groups directory
export MEMORY_GUARDIAN_GROUPS_DIR="$PROJECT_DIR/groups"

# Ensure IPC directory exists
mkdir -p "$IPC_DIR"

# Run the integrity checker and generate the IPC message in one Python call
REPORT=$("$PYTHON3" "$CHECKER" 2>&1)
EXIT_CODE=$?

TIMESTAMP=$(date +%s%N)

"$PYTHON3" -c "
import json, sys

claire_jid = '$CLAIRE_JID'
exit_code = $EXIT_CODE
report_raw = sys.stdin.read()

if exit_code != 0:
    text = f'*Memory Guardian* ⚠️ checker failed (exit {exit_code}):\n\`\`\`\n{report_raw}\n\`\`\`'
else:
    report = json.loads(report_raw)
    has_failures = report['has_failures']

    if has_failures:
        header = '*Memory Guardian* ⚠️ issues found'
    else:
        header = '*Memory Guardian* ✅ all groups healthy'

    lines = []
    for name, g in report['groups'].items():
        icon = '✅' if g['status'] == 'PASS' else '❌'
        short = name.replace('telegram_', '')
        if g['issues']:
            issues = '; '.join(g['issues'][:2])
            if len(issues) > 120:
                issues = issues[:117] + '...'
            lines.append(f'  {icon} {short}: {issues}')
        else:
            lines.append(f'  {icon} {short}')

    text = header + '\n\n' + '\n'.join(lines)

msg = {'type': 'message', 'chatJid': claire_jid, 'text': text}
print(json.dumps(msg))
" <<< "$REPORT" > "$IPC_DIR/memory-guardian-${TIMESTAMP}.json"

echo "[$(date)] Memory guardian check complete (exit=$EXIT_CODE)"
