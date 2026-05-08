#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
FOLLOWUP_QUEUE_FILE="$BATCH_DIR/followup-queue.tsv"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"
FOLLOWUP_THRESHOLD=3.5

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
BATCH_SIZE=30

usage() {
  cat <<'USAGE'
career-ops batch runner — process job jobs in batch via claude -p workers
Uses your default Claude model (Claude Max subscription).

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry jobs marked as "failed" in state
  --start-from N       Start from job ID N (skip earlier IDs)
  --max-retries N      Max retry attempts per job (default: 2)
  --min-score N        Skip jobs scoring below N (default: 0 = off)
  --batch-size N       Max jobs to process per run (default: 30, 0 = unlimited)
  -h, --help           Show this help

Files:
  batch-input.tsv      Input jobs (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending jobs
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed jobs
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add jobs first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"

  if [[ ! -f "$FOLLOWUP_QUEUE_FILE" ]]; then
    printf 'id\tdate\tscore\tcompany\trole\turl\tpdf\tcustom_resume\tcv_changes\tinterview_prep\tnotes\n' > "$FOLLOWUP_QUEUE_FILE"
  fi
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

get_score() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "-"
    return
  fi
  local score
  score=$(awk -F'\t' -v id="$id" '$1 == id { print $7 }' "$STATE_FILE")
  echo "${score:--}"
}

get_url() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo ""
    return
  fi
  local url
  url=$(awk -F'\t' -v id="$id" '$1 == id { print $2 }' "$STATE_FILE")
  echo "${url:-}"
}

get_queue_field() {
  local id="$1" col="$2"
  if [[ ! -f "$FOLLOWUP_QUEUE_FILE" ]]; then
    echo "-"
    return
  fi
  local val
  val=$(awk -F'\t' -v id="$id" -v col="$col" 'NR > 1 && $1 == id { print $col; exit }' "$FOLLOWUP_QUEUE_FILE")
  echo "${val:--}"
}

enqueue_followup_unlocked() {
  local id="$1" date="$2" score="$3" company="$4" role="$5" url="$6"

  if [[ ! -f "$FOLLOWUP_QUEUE_FILE" ]]; then
    printf 'id\tdate\tscore\tcompany\trole\turl\tpdf\tcustom_resume\tcv_changes\tinterview_prep\tnotes\n' > "$FOLLOWUP_QUEUE_FILE"
  fi

  if awk -F'\t' -v id="$id" 'NR > 1 && $1 == id { found=1 } END { exit !found }' "$FOLLOWUP_QUEUE_FILE"; then
    return 0
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\tpending\tpending\tpending\tpending\tqueued-from-batch\n' \
    "$id" "$date" "$score" "$company" "$role" "$url" >> "$FOLLOWUP_QUEUE_FILE"
}

enqueue_followup() {
  run_with_state_lock enqueue_followup_unlocked "$@"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      # Only process if num is numeric (3 digits like 001, 002, etc)
      if [[ "$num" =~ ^[0-9]+$ ]]; then
        num=$((10#$num)) # Remove leading zeros for arithmetic
        if (( num > max_num )); then
          max_num=$num
        fi
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local date
  date=$(date +%Y-%m-%d)
  local jd_file="/tmp/batch-jd-${id}.txt"

  # Mark as processing immediately (no report number in triage mode)
  update_state "$id" "$url" "processing" "$started_at" "-" "-" "-" "-" "$retries"

  echo "--- Processing offer #$id: $url (attempt $((retries + 1)))"

  # Build the prompt with placeholders replaced
  local prompt
  prompt="Process this job offer in batch score-first mode. Output only CV match score (1-5); add tracker entry only if score >= 3.5; do not generate reports or PDFs in batch."
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${id}.log"

  # Prepare system prompt with placeholders resolved
  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  # Escape sed delimiter characters in variables to prevent substitution breakage
  local esc_url esc_jd_file esc_date esc_id
  esc_url="${url//\\/\\\\}"
  esc_url="${esc_url//|/\\|}"
  esc_jd_file="${jd_file//\\/\\\\}"
  esc_jd_file="${esc_jd_file//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|-|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    "$PROMPT_FILE" > "$resolved_prompt"

  # Launch claude -p worker (uses default model from Claude Max subscription)
  local exit_code=0
  claude -p \
    --dangerously-skip-permissions \
    --append-system-prompt-file "$resolved_prompt" \
    "$prompt" \
    > "$log_file" 2>&1 || exit_code=$?

  # Cleanup resolved prompt
  rm -f "$resolved_prompt"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    # Try to extract score from worker output
    local score="-"
    local score_match
   score_match=$(sed -nE 's/.*"score":[[:space:]]*([0-9.]+).*/\1/p' "$log_file" 2>/dev/null | head -1 || true)
    if [[ -n "$score_match" ]]; then
      score="$score_match"
    fi

    # Extract company and role from worker JSON output
    local company="-" role="-"
    local company_match role_match
    company_match=$(sed -nE 's/.*"company":[[:space:]]*"([^"]+)".*/\1/p' "$log_file" 2>/dev/null | head -1 || true)
    role_match=$(sed -nE 's/.*"role":[[:space:]]*"([^"]+)".*/\1/p' "$log_file" 2>/dev/null | head -1 || true)
    [[ -n "$company_match" ]] && company="$company_match"
    [[ -n "$role_match" ]] && role="$role_match"

    # Check min-score gate
    if [[ "$score" != "-" && -n "$score" ]] && (( $(echo "$MIN_SCORE > 0" | bc -l) )); then
      if (( $(echo "$score < $MIN_SCORE" | bc -l) )); then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "-" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    # Queue next-step actions after batch for strong matches.
    if [[ "$score" != "-" && -n "$score" ]] && (( $(echo "$score >= $FOLLOWUP_THRESHOLD" | bc -l) )); then
      enqueue_followup "$id" "$date" "$score" "$company" "$role" "$url"
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "-" "$score" "-" "$retries"
    echo "    ✅ Completed (score: $score)"
  else
    retries=$((retries + 1))
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "-" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if [[ "$sscore" != "-" && -n "$sscore" ]]; then
          score_sum=$(echo "$score_sum + $sscore" | bc 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(echo "scale=1; $score_sum / $score_count" | bc 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

print_followup_prompt() {
  local -a batch_ids=("$@")

  echo ""
  echo "=== Post-Batch Next Steps (score >= $FOLLOWUP_THRESHOLD) ==="

  local found=0
  local id score url
  for id in "${batch_ids[@]}"; do
    score=$(get_score "$id")
    if [[ "$score" == "-" || -z "$score" ]]; then
      continue
    fi
    if ! (( $(echo "$score >= $FOLLOWUP_THRESHOLD" | bc -l) )); then
      continue
    fi
    url=$(get_url "$id")
    found=1
    local company role
    company=$(get_queue_field "$id" 4)
    role=$(get_queue_field "$id" 5)
    echo "  #$id | $company \u2014 $role | score $score | $url"
    echo "    next actions: pdf, custom_resume, cv_changes, interview_prep"
  done

  if (( found == 0 )); then
    echo "No queued follow-ups yet."
    return
  fi

  echo ""
  echo "Run follow-up actions with:"
  echo "  ./batch/on-demand-runner.sh --id <id> --action <action>"
  echo ""
  echo "  Actions: pdf | custom_resume | cv_changes | interview_prep"
  echo "  Queue:   $FOLLOWUP_QUEUE_FILE"
}

# Main
main() {
  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
  fi

  init_state

  # Count input jobs (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No jobs in $INPUT_FILE. Add jobs first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  local batch_size_label
  if (( BATCH_SIZE > 0 )); then
    batch_size_label="$BATCH_SIZE"
  else
    batch_size_label="unlimited"
  fi
  echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Batch size: $batch_size_label"
  echo "Input: $total_input jobs"
  echo ""

  # Build list of jobs to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed jobs
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip completed jobs
      if [[ "$status" == "completed" ]]; then
        continue
      fi
      # Skip failed jobs that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No jobs to process."
    print_summary
    exit 0
  fi

  # Apply batch size cap
  if (( BATCH_SIZE > 0 && pending_count > BATCH_SIZE )); then
    pending_ids=("${pending_ids[@]:0:$BATCH_SIZE}")
    pending_urls=("${pending_urls[@]:0:$BATCH_SIZE}")
    pending_sources=("${pending_sources[@]:0:$BATCH_SIZE}")
    pending_notes=("${pending_notes[@]:0:$BATCH_SIZE}")
    echo "Pending: $pending_count jobs (capped to $BATCH_SIZE per --batch-size)"
    pending_count=$BATCH_SIZE
  else
    echo "Pending: $pending_count jobs"
  fi
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count jobs"
    exit 0
  fi

  # Process jobs
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        sleep 1
      done

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary
  print_followup_prompt "${pending_ids[@]}"
}

main "$@"
