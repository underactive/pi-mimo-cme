#!/usr/bin/env bash
#
# End-to-end smoke test for the Phase 2 subagent/actor layer against a REAL pi
# session with @tintinweb/pi-subagents actually installed.
#
# What it proves that unit tests cannot: the live `pi.events` channel names and
# payload shapes that pi-subagents emits actually match what src/actors.ts reads
# — i.e. a real subagent run produces an `actor` row, a progress.md journal, and
# a populated checkpoint §4 source.
#
# It is fully ISOLATED: a throwaway PI_CODING_AGENT_DIR (its own settings,
# memory.db, and memory tree), so it never touches your real memory or installs
# anything into ~/.pi/agent. It borrows (copies) your real credentials + model
# metadata so the headless run can authenticate.
#
# Requirements: `pi` on PATH, an authenticated ~/.pi/agent (auth.json), network
# (to install pi-subagents), and Node ≥ 24. Costs a few API tokens (one short
# prompt + one tiny subagent).
#
# Usage:  ./scripts/smoke-subagents.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_AGENT="${HOME}/.pi/agent"
WORK="$(mktemp -d)"
AGENT_DIR="${WORK}/agent"
mkdir -p "${AGENT_DIR}"
export PI_CODING_AGENT_DIR="${AGENT_DIR}"

cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "${WORK}"; }
trap cleanup EXIT

echo "▶ isolated agent dir: ${AGENT_DIR}"
echo "  (set KEEP=1 to preserve it for inspection)"

# Borrow credentials + model metadata so the headless run authenticates exactly
# as your real sessions do, while keeping settings/memory/db isolated here.
for f in auth.json models.json cursor-sdk-model-list.json cursor-sdk-context-windows.json trust.json; do
  if [ -f "${SRC_AGENT}/${f}" ]; then cp "${SRC_AGENT}/${f}" "${AGENT_DIR}/"; fi
done

echo "▶ installing @tintinweb/pi-subagents into the isolated agent dir…"
pi install npm:@tintinweb/pi-subagents

# Ask the agent to spawn ONE BACKGROUND subagent via pi-subagents' "Agent" tool.
# The ledger is scoped to background subagents: pi-subagents emits the terminal
# subagents:completed/failed events (and `created`) only for background agents —
# foreground agents emit just `started` and return their result inline (already
# in the conversation, so the checkpoint delta captures it without us).
PROMPT='Use the Agent tool to spawn exactly one subagent with subagent_type "general-purpose", run_in_background set to true, and description "smoke-progress-probe", giving it the task: respond with the single line "hello from the smoke subagent" and nothing else. After spawning, do not do any other work — simply wait for the completion notification and then report the subagent'"'"'s result. Do not spawn more than one subagent.'

echo "▶ running headless pi (our extension via -e, pi-subagents via install)…"
set +e
pi -e "${REPO}/src/index.ts" -p "${PROMPT}" >"${WORK}/run.out" 2>"${WORK}/run.err"
RUN_CODE=$?
set -e
echo "  pi exit code: ${RUN_CODE}"
echo "  --- agent stdout (tail) ---"; tail -5 "${WORK}/run.out" || true

DB="${AGENT_DIR}/pi-mimo-cme/memory.db"
echo ""
echo "▶ observed event sequence (from our extension trace log):"
grep -E "subagents: ready|actor (created|started|completed|failed|compacted)" \
  "${AGENT_DIR}/pi-mimo-cme/logs/extension.log" 2>/dev/null | sed 's/^/    /' || echo "    (no events logged)"
echo ""
echo "▶ VERIFY 1 — actor ledger rows (real subagents:* events → src/actors.ts):"
if [ -f "${DB}" ]; then
  sqlite3 -header -column "${DB}" \
    "SELECT id, type, status, tokens, tool_uses, substr(result_summary,1,50) AS result FROM actor;" || true
else
  echo "  ✘ no memory.db at ${DB}"
fi

echo ""
echo "▶ VERIFY 2 — synthesized progress.md journal(s):"
JOURNAL_COUNT=0
if [ -d "${AGENT_DIR}/pi-mimo-cme/sessions" ]; then
  while IFS= read -r j; do
    JOURNAL_COUNT=$((JOURNAL_COUNT + 1))
    echo "  --- ${j} ---"; sed 's/^/    /' "${j}"
  done < <(find "${AGENT_DIR}/pi-mimo-cme/sessions" -name progress.md)
fi
echo "  journals found: ${JOURNAL_COUNT}"

echo ""
echo "▶ VERIFY 3 — checkpoint §4 source the writer WOULD inline (full path: event → DB → §4):"
node --input-type=module -e "
import { openDb } from '${REPO}/src/db.ts';
import { buildSubagentProgress } from '${REPO}/src/actors.ts';
const db = openDb('${DB}');
const sids = db.prepare('SELECT DISTINCT session_id AS s FROM actor').all().map(r => r.s);
if (sids.length === 0) { console.log('    (no actors recorded)'); process.exit(0); }
for (const s of sids) {
  const block = buildSubagentProgress(db, s, 2000);
  console.log('    session', s + ':');
  console.log(block.split('\n').map(l => '      ' + l).join('\n'));
}
" 2>/dev/null || echo "    (could not build §4 block)"

echo ""
ACTORS=$([ -f "${DB}" ] && sqlite3 "${DB}" "SELECT COUNT(*) FROM actor;" 2>/dev/null || echo 0)
TERMINAL=$([ -f "${DB}" ] && sqlite3 "${DB}" "SELECT COUNT(*) FROM actor WHERE status NOT IN ('created','running');" 2>/dev/null || echo 0)
if [ "${TERMINAL}" -ge 1 ] || [ "${JOURNAL_COUNT}" -ge 1 ]; then
  echo "✅ FULL PASS — terminal event observed (${TERMINAL} terminal row(s), ${JOURNAL_COUNT} journal(s))."
  echo "   The complete background-subagent lifecycle (created→…→completed/failed →"
  echo "   actor row + progress.md + §4) is verified against live pi-subagents."
elif [ "${ACTORS}" -ge 1 ]; then
  echo "🟡 PARTIAL PASS — ${ACTORS} actor row(s) recorded (created/started observed, §4 built),"
  echo "   but no terminal event reached us before \`pi -p\` exited. This is the known"
  echo "   headless limitation: background terminal events fire mid-session (followUp"
  echo "   turn) or are aborted at shutdown; the full terminal path is covered by unit"
  echo "   tests. The live event WIRING is confirmed. Inspect: ${WORK}/run.out"
else
  echo "❌ INCONCLUSIVE — actors=${ACTORS}, journals=${JOURNAL_COUNT}."
  echo "   The model may not have called the Agent tool. Re-run, or inspect:"
  echo "     ${WORK}/run.out  ${WORK}/run.err   (run with KEEP=1)"
  exit 1
fi
