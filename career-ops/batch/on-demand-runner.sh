#!/usr/bin/env bash
set -euo pipefail

# career-ops on-demand follow-up runner
# Runs a single follow-up action for a queued offer and marks it done.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
QUEUE_FILE="$SCRIPT_DIR/followup-queue.tsv"
MODES_DIR="$PROJECT_DIR/modes"
LOGS_DIR="$SCRIPT_DIR/logs"

usage() {
  cat <<'USAGE'
career-ops on-demand follow-up runner

Runs a single follow-up action for a queued offer and marks it done.

Usage: on-demand-runner.sh --id <id> --action <action> [OPTIONS]

Options:
  --id <id>        Offer ID from followup-queue.tsv
  --action <name>  Action to run: pdf | custom_resume | cv_changes | interview_prep
  --force          Re-run even if action is already marked done
  -h, --help       Show this help

Examples:
  # Generate tailored PDF for offer #12
  ./batch/on-demand-runner.sh --id 12 --action pdf

  # Generate interview prep for offer #7
  ./batch/on-demand-runner.sh --id 7 --action interview_prep

  # List pending actions
  node batch/followup-queue.mjs list --pending
USAGE
}

ID=""
ACTION=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)     ID="$2"; shift 2 ;;
    --action) ACTION="$2"; shift 2 ;;
    --force)  FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

[[ -z "$ID" ]]     && { echo "ERROR: --id is required"; usage; exit 1; }
[[ -z "$ACTION" ]] && { echo "ERROR: --action is required"; usage; exit 1; }

case "$ACTION" in
  pdf|custom_resume|cv_changes|interview_prep) ;;
  *) echo "ERROR: Invalid action '$ACTION'. Use: pdf, custom_resume, cv_changes, interview_prep"; exit 1 ;;
esac

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "ERROR: Queue file not found: $QUEUE_FILE"
  exit 1
fi

# Read the row for this ID
# Columns: id date score company role url pdf custom_resume cv_changes interview_prep notes
ROW=$(awk -F'\t' -v id="$ID" 'NR > 1 && $1 == id { print; exit }' "$QUEUE_FILE")

if [[ -z "$ROW" ]]; then
  echo "ERROR: ID $ID not found in followup-queue.tsv"
  exit 1
fi

IFS=$'\t' read -r q_id q_date q_score q_company q_role q_url \
  q_pdf q_custom_resume q_cv_changes q_interview_prep q_notes <<< "$ROW"

# Check current state of the requested action
case "$ACTION" in
  pdf)            current_state="$q_pdf" ;;
  custom_resume)  current_state="$q_custom_resume" ;;
  cv_changes)     current_state="$q_cv_changes" ;;
  interview_prep) current_state="$q_interview_prep" ;;
esac

if [[ "$current_state" == "done" && "$FORCE" == "false" ]]; then
  echo "Action '$ACTION' for ID $ID is already done. Use --force to re-run."
  exit 0
fi

mkdir -p "$LOGS_DIR"
LOG_FILE="$LOGS_DIR/on-demand-${ACTION}-${ID}.log"

echo "=== On-demand: $ACTION for #$ID ==="
echo "Company: $q_company | Role: $q_role | Score: $q_score/5"
echo "URL: $q_url"
echo ""

# Invoke the appropriate mode via claude -p
case "$ACTION" in
  pdf|custom_resume)
    MODE_FILE="$MODES_DIR/pdf.md"
    if [[ ! -f "$MODE_FILE" ]]; then
      echo "ERROR: Mode file not found: $MODE_FILE"
      exit 1
    fi
    PROMPT="Generate an ATS-optimized tailored resume. Company: $q_company | Role: $q_role | JD URL: $q_url | CV Match Score: $q_score/5. Follow the full pipeline in the system prompt."
    claude -p \
      --dangerously-skip-permissions \
      --append-system-prompt-file "$MODE_FILE" \
      "$PROMPT" \
      | tee "$LOG_FILE"
    ;;

  cv_changes)
    PROMPT="Generate a targeted CV and LinkedIn update plan for this role.
Company: $q_company | Role: $q_role | JD URL: $q_url | CV Match Score: $q_score/5.

Read cv.md and fetch the JD. Identify 5-8 specific, high-impact changes to increase match:
- Which bullets to rewrite (quote original → provide replacement)
- Which JD keywords are missing and exactly where to insert them
- Which projects to surface or de-emphasize
- LinkedIn headline and About section adjustments

Rank changes by impact. Never invent experience or metrics."
    claude -p \
      --dangerously-skip-permissions \
      "$PROMPT" \
      | tee "$LOG_FILE"
    ;;

  interview_prep)
    MODE_FILE="$MODES_DIR/interview-prep.md"
    if [[ ! -f "$MODE_FILE" ]]; then
      echo "ERROR: Mode file not found: $MODE_FILE"
      exit 1
    fi
    PROMPT="Run interview preparation for this role. Company: $q_company | Role: $q_role | JD URL: $q_url | CV Match Score: $q_score/5. Follow the full prep framework in the system prompt."
    claude -p \
      --dangerously-skip-permissions \
      --append-system-prompt-file "$MODE_FILE" \
      "$PROMPT" \
      | tee "$LOG_FILE"
    ;;
esac

echo ""
echo "=== Marking '$ACTION' as done for ID $ID ==="
node "$SCRIPT_DIR/followup-queue.mjs" update --id "$ID" --action "$ACTION" --state done
echo ""
echo "Log: $LOG_FILE"
