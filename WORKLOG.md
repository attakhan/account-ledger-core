# WORKLOG

Times are Asia/Dubai (UTC+04:00), taken from `date` at the moment of writing.
Each entry records what was done and what was decided. The entries are not tidied up afterwards.

---

### 2026-09-27 17:22 — brief received
Read the brief. It asks for an in-memory ledger core, a replay of 10 events over 6 days, and 8 acceptance
criteria, some of which are wrong. The user wants Node.js, error handling and "large volume".

### 2026-09-27 17:24 — user addendum
The user asked for a `postingDate` that stays equal to the first date the event came in. I decided that
every posting carries `postingDate` (never changes) and `valueDate`, and I added a separate `processedOnDay`
field for events that arrive after their day was closed (E10).

### 2026-09-27 17:30 — hand calculation before writing code
Worked the ACC-001 stream on paper first, so the code has something independent to be checked against.
- D1 250.00. D2 250.00 with Auth-A 200 approved (avail 50.00). D3 650.00. D4 465.00 (Auth-A settles 185,
  15 released). Auth-Z has no auth, so it is rejected.
- E7 is booked on D5 with value D2. At the D5 close, D2 = 250 − 620 = **−370.00** before the fee. So
  criterion 1 holds.
- After the re-run: D2 −395 (fee), D3 +5.00 (no fee), D4 −205 (fee), D5 −230 (fee). That makes **three**
  fees, not one, so criterion 2 is wrong.
- E8 Auth-B: at booking the balance is −155.00, so available after the hold is −245.00 and it is
  **declined**. Criterion 5 ("if approved") is only conditionally relevant.
- E9 reverses on D6. The balance is 390.00 before interest, against 465.00 before E7. The fees stay, so
  criterion 6 is wrong.
- 10.000 / 3 → 3.334 + 3.333 + 3.333. Three lots of 3.334 would be 10.002, so criterion 7 is wrong.
- "Remainder discarded" contradicts "must sum exactly", so criterion 8 is wrong.
- Open question: criterion 4 (reject an orphan settlement). Real card schemes force-post these. Leaning
  towards accepting the criterion, because the brief's own output asks for "errors" and the note on E6 is
  there to produce one.

### 2026-09-27 17:30 — repo scaffolded
`git init`, scenario NDJSON, accounts.json, package.json. No dependencies, only the Node standard library
(node:test, worker_threads, readline).
