---
name: contacts
description: Look up, create, or update contact files in the vault. Use when the user asks about a person, says "who is X", "look up X", "update X's contact", or when you need context about someone mentioned in email or discussion.
---

# /contacts — People Contact Lookup & Management

## When to use

- "Who is [name]?" or "What do we know about [name]?"
- "Look up [name]"
- "Update [name]'s contact" or "Add [name] as a contact"
- When you encounter someone in email/calendar and need their context
- When Mike asks you to remember something about a person

## How to look up a contact

1. Search by name in the vault:

```bash
ls /workspace/extra/claire-vault/people/contacts/ | grep -i "{lastname}" 2>/dev/null
ls /workspace/extra/claire-vault/people/lab/ | grep -i "{lastname}" 2>/dev/null
```

2. If found, read the file and present the key info: name, role, institution, stage, last contact, next action, and recent interactions.

3. If not found in files, search QMD: `mcp__qmd__query` with the person's name to find mentions across the vault.

4. If truly unknown, say so and offer to create a contact file if Mike can provide context.

## How to create a new contact

1. Confirm the person doesn't already exist (search first)
2. Create the file at `/workspace/extra/claire-vault/people/contacts/{firstname-lastname}.md`
3. Use this format:

```markdown
---
type: collaborator
name: "Full Name"
email: "email@example.com"
institution: "University/Organization"
role: PI | Collaborator | Trainee | Admin
stage: active
next_action: ""
last_contact: "YYYY-MM-DD"
projects: []
---

# Full Name

## Context
How Mike knows them. What the relationship is about.

## Collaboration History
Key milestones — when they met, shared projects, papers.

## Interactions
- YYYY-MM-DD | type | description

## Notes
Anything useful to remember — preferences, timezone, communication style.
```

## How to update a contact

When you learn new information about someone:
1. Read their existing file
2. Update the relevant fields:
   - `last_contact` → set to today's date
   - `next_action` → set if there's a pending follow-up
   - `stage` → update if status changed (prospect → active, active → dormant)
   - Add new entry to Interactions section with date, type, and description
   - Update Context or Notes with new information
3. Write the updated file back

## For lab members

Lab member files are at `/workspace/extra/claire-vault/people/lab/{firstname-lastname}.md` and have additional sections for Position, Milestones, Papers, Grants, and 1:1 Notes. Use the template at `people/lab/_template.md`.

## Output format

When presenting a contact lookup, keep it concise:

```
*[Name]* — [Role] at [Institution]
Stage: [active/dormant/etc] | Last contact: [date]
Next action: [pending item or "none"]
Context: [1-2 sentence summary]
Recent: [last 2-3 interactions]
```
