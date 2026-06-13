#!/usr/bin/env bash
#
# Confirmation gate for the rpiv-todo task-graph integration (plan §7.5).
#
# Proves whether the `todo` tool-result `details` payload (the task snapshot)
# survives in the branch messages pi-mimo-cme reaches via getBranch() — using a
# throwaway probe that runs the EXACT branchMessages + replay scan the real
# Option A reader would use. Fully isolated (throwaway PI_CODING_AGENT_DIR,
# borrowed auth) like scripts/smoke-subagents.sh; installs @juicesharp/rpiv-todo.
#
# Usage:  ./scripts/smoke-todo-branch.sh   (KEEP=1 to preserve the work dir)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_AGENT="${HOME}/.pi/agent"
WORK="$(mktemp -d)"
AGENT_DIR="${WORK}/agent"
mkdir -p "${AGENT_DIR}"
export PI_CODING_AGENT_DIR="${AGENT_DIR}"
export PROBE_OUT="${WORK}/probe.json"

cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "${WORK}"; }
trap cleanup EXIT

echo "▶ isolated agent dir: ${AGENT_DIR}   (KEEP=1 to preserve)"

for f in auth.json models.json cursor-sdk-model-list.json cursor-sdk-context-windows.json trust.json; do
  if [ -f "${SRC_AGENT}/${f}" ]; then cp "${SRC_AGENT}/${f}" "${AGENT_DIR}/"; fi
done

echo "▶ installing @juicesharp/rpiv-todo into the isolated agent dir…"
pi install npm:@juicesharp/rpiv-todo

# Directive prompt: force two real `todo` tool calls, no other work.
PROMPT='Use the todo tool to create exactly two tasks, one per call: first subject "probe task alpha", then subject "probe task beta". Then mark task #1 in_progress with the todo tool. Do not do anything else — no files, no other tools. After the three todo calls, reply with the single word DONE.'

echo "▶ running headless pi with the probe extension + rpiv-todo…"
set +e
pi -e "${REPO}/scripts/probe-todo-branch.ts" -p "${PROMPT}" >"${WORK}/run.out" 2>"${WORK}/run.err"
RUN_CODE=$?
set -e
echo "  pi exit code: ${RUN_CODE}"
echo "  --- agent stdout (tail) ---"; tail -5 "${WORK}/run.out" || true

echo ""
echo "▶ probe diagnostic (${PROBE_OUT}):"
if [ ! -f "${PROBE_OUT}" ]; then
  echo "  ✘ no probe output — turn_end/session_shutdown never fired or probe failed to load."
  echo "    inspect: ${WORK}/run.out  ${WORK}/run.err   (re-run with KEEP=1)"
  exit 1
fi
cat "${PROBE_OUT}" | sed 's/^/    /'

VALID=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('${PROBE_OUT}','utf8'));
console.log(d.todoResultsWithValidTaskDetails ?? 0);
")
TASKS=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('${PROBE_OUT}','utf8'));
console.log(d.lastTasksCount ?? 0);
")
# The SHIPPED §4 block must render the tasks (proves the real code path, not just
# that the payload is present).
SHIPPED=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('${PROBE_OUT}','utf8'));
const ok = (d.shippedSnapshotCount ?? 0) >= 2 && /#1/.test(d.shippedTaskTreeBlock ?? '') && /#2/.test(d.shippedTaskTreeBlock ?? '');
console.log(ok ? 'ok' : 'no');
")

echo ""
if [ "${VALID}" -ge 1 ] && [ "${TASKS}" -ge 2 ] && [ "${SHIPPED}" = "ok" ]; then
  echo "✅ PASS — ${VALID} todo tool-result(s) carried a valid TaskDetails payload in the branch;"
  echo "   the latest snapshot reconstructs ${TASKS} tasks via getBranch(), and the SHIPPED"
  echo "   src/tasks.ts (readTaskSnapshot → buildTaskTree) renders the live §4 Task tree block:"
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('${PROBE_OUT}','utf8'));
console.log((d.shippedTaskTreeBlock ?? '').split('\n').map(l => '     ' + l).join('\n'));
"
elif [ "$(node -e "import('node:fs').then(fs=>{const d=JSON.parse(fs.readFileSync('${PROBE_OUT}','utf8'));console.log(d.todoToolResults??0)})" 2>/dev/null || echo 0)" -ge 1 ]; then
  echo "❌ FAIL — todo tool-result(s) reached the branch but WITHOUT a usable details payload"
  echo "   (validTaskDetails=${VALID}, lastTasks=${TASKS}). Inspect firstTodoResultKeys/Sample above:"
  echo "   the snapshot may be nested elsewhere or stripped in-process. Option A blocked — STOP."
  exit 2
else
  echo "❓ INCONCLUSIVE — the model may not have called the todo tool (todoToolResults=0)."
  echo "   Re-run, or inspect ${WORK}/run.out with KEEP=1."
  exit 3
fi
