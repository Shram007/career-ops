#!/usr/bin/env bash
set -euo pipefail

# score-pipeline.sh — parallel claude -p scorer for career-ops pipeline files
#
# Reads pending [ ] entries from a pipeline file, pre-screens entries that
# already have disqualifying enrichment tags (non-US loc, exp too high),
# then runs parallel claude -p workers to score the rest. Results are written
# back to the pipeline file in [x] format, and qualified offers are queued
# in batch/tracker-additions/ for merge-tracker.mjs to pick up.
#
# Usage: ./batch/score-pipeline.sh [OPTIONS]
#
# Options:
#   --referral        Process data/pipeline-referral.md (default)
#   --discovery       Process data/pipeline.md
#   --file <path>     Process a specific pipeline file
#   --parallel N      Workers to run at once per batch (default: 3)
#   --batch-size N    Entries per batch before writing results (default: 5)
#   --dry-run         Print plan without fetching or writing
#   --min-score N     Minimum score to add to tracker (default: 3.0)
#   --max-exp N       Pre-screen hold if exp:{N}yr > N, 0=off (default: 0)
#   --no-prescreen    Disable all tag-based pre-screening
#   -h, --help        Show this help

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKER_ADDITIONS_DIR="$SCRIPT_DIR/tracker-additions"
LOGS_DIR="$SCRIPT_DIR/logs"
FOLLOWUP_QUEUE="$SCRIPT_DIR/followup-queue.tsv"
PROMPT_TEMPLATE="$SCRIPT_DIR/score-pipeline-prompt.md"
LOCK_FILE="$PROJECT_DIR/tmp/score-pipeline.pid"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
STATE_DIR="$PROJECT_DIR/tmp/score-pipeline-${RUN_ID}"
MAIN_PID="${BASHPID:-$$}"

# Defaults
PIPELINE_FILE="$PROJECT_DIR/data/pipeline-referral.md"
PARALLEL=3
BATCH_SIZE=5
DRY_RUN=false
MIN_SCORE=3.0
MAX_EXP=0
NO_PRESCREEN=false
FOLLOWUP_THRESHOLD=3.0

usage() {
  cat <<'USAGE'
score-pipeline.sh — parallel claude -p scorer for career-ops pipeline files

Usage: ./batch/score-pipeline.sh [OPTIONS]

Options:
  --referral        Process data/pipeline-referral.md (default)
  --discovery       Process data/pipeline.md
  --file <path>     Process a specific pipeline file
  --parallel N      Workers at once per batch (default: 3)
  --batch-size N    Entries per batch (default: 5)
  --dry-run         Show plan without executing
  --min-score N     Tracker threshold (default: 3.0)
  --max-exp N       Pre-screen if exp:{N}yr > N, 0=off (default: 0)
  --no-prescreen    Disable tag-based pre-screening
  -h, --help        Show this help

Examples:
  # Dry run to preview what would be scored
  ./batch/score-pipeline.sh --dry-run

  # Score referral pipeline, 3 workers at a time
  ./batch/score-pipeline.sh --referral --parallel 3

  # Score discovery pipeline, pre-screen exp > 5
  ./batch/score-pipeline.sh --discovery --max-exp 5
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --referral)     PIPELINE_FILE="$PROJECT_DIR/data/pipeline-referral.md"; shift ;;
    --discovery)    PIPELINE_FILE="$PROJECT_DIR/data/pipeline.md"; shift ;;
    --file)         PIPELINE_FILE="$2"; shift 2 ;;
    --parallel)     PARALLEL="$2"; shift 2 ;;
    --batch-size)   BATCH_SIZE="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --min-score)    MIN_SCORE="$2"; shift 2 ;;
    --max-exp)      MAX_EXP="$2"; shift 2 ;;
    --no-prescreen) NO_PRESCREEN=true; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

SCOPE="referral"
if [[ "$PIPELINE_FILE" == *"pipeline.md" ]]; then
  SCOPE="discovery"
fi

echo ""
echo "[scorer] engine=primary-batch scope=${SCOPE} file=${PIPELINE_FILE} run_id=${RUN_ID}"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[scorer] mode=dry-run"
fi
echo ""

# ── Lock ──────────────────────────────────────────────────────────────────────

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")"
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another score-pipeline is running (PID $old_pid)"
      echo "If stale, remove: $LOCK_FILE"
      exit 1
    fi
    echo "WARN: Stale lock (PID $old_pid). Removing."
    rm -f "$LOCK_FILE"
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  [[ "${BASHPID:-$$}" == "$MAIN_PID" ]] && rm -f "$LOCK_FILE" 2>/dev/null || true
}
trap release_lock EXIT

# ── Pre-screening ─────────────────────────────────────────────────────────────

# Returns 0 (true) if the loc value looks non-US based on enrichment format.
is_non_us_loc() {
  local loc="$1"
  # enrich-pipeline.mjs compresses country names into 2-3 letter codes followed by dash:
  # AUS-NSW-Sydney, GBR-Cambridge, etc.  US jobs use US-WA-Seattle or bare city names.
  [[ "$loc" =~ ^(AUS|GBR|NZL|SGP|IND|BRA|CHL|VNM|JPN|DEU|FRA|CAN|CHN|KOR|MEX|ARG|COL|IDN|MYS|PHL|THA|UAE|ZAF|ISR|POL|NLD|SWE|NOR|DNK|FIN|CHE|BEL|AUT|IRL|PRT|ESP|ITA|GRC|TUR|RUS|UKR|CZE|HUN|ROU|BGR|HRV|SVK|SVN|EST|LVA|LTU)- ]] && return 0
  # Known non-US cities that appear without country prefix
  [[ "$loc" =~ ^(Gurugram|Hyderabad|Bangalore|Mumbai|Pune|Chennai|Delhi|Kolkata|Santiago|Sao-Paulo|Dublin|Amsterdam|Berlin|Paris|London|Toronto|Vancouver|Montreal|Singapore|Tokyo|Seoul|Lagos|Cairo|Nairobi|Sydney|Melbourne|Brisbane|Auckland)$ ]] && return 0
  return 1
}

# Returns 0 (true) if tags contain exp > MAX_EXP
exp_over_limit() {
  local tags="$1"
  [[ "$MAX_EXP" -eq 0 ]] && return 1
  local exp_val
  exp_val=$(printf '%s' "$tags" | grep -oE 'exp:([0-9]+)yr' | grep -oE '[0-9]+' | head -1)
  [[ -z "$exp_val" ]] && return 1
  (( exp_val > MAX_EXP )) && return 0
  return 1
}

# Outputs a prescreen reason string, or empty string if entry should be fetched.
prescreen_reason() {
  local tags="$1"
  [[ "$NO_PRESCREEN" == "true" ]] && { printf ''; return; }

  local loc_val
  loc_val=$(printf '%s' "$tags" | grep -oE 'loc:[^[:space:]|]+' | sed 's/loc://' | head -1)
  if [[ -n "$loc_val" ]] && is_non_us_loc "$loc_val"; then
    printf 'location:%s' "$loc_val"
    return
  fi

  if exp_over_limit "$tags"; then
    local exp_tag
    exp_tag=$(printf '%s' "$tags" | grep -oE 'exp:[0-9]+yr' | head -1)
    printf '%s' "$exp_tag"
    return
  fi

  printf ''
}

# ── Pipeline parsing ──────────────────────────────────────────────────────────

# Global parallel arrays populated by parse_pipeline()
declare -a ENTRY_DATES ENTRY_URLS ENTRY_COMPANIES ENTRY_ROLES ENTRY_TAGS

parse_pipeline() {
  ENTRY_DATES=()
  ENTRY_URLS=()
  ENTRY_COMPANIES=()
  ENTRY_ROLES=()
  ENTRY_TAGS=()

  while IFS= read -r line; do
    # Only pending [ ] lines
    [[ "$line" =~ ^-\ \[\ \]\ .* ]] || continue

    # Strip "- [ ] " prefix then split on " | "
    local content="${line#- \[ \] }"
    IFS='|' read -ra fields <<< "$content"

    local date url company role
    date=$(printf '%s' "${fields[0]:-}" | xargs)
    url=$(printf '%s' "${fields[1]:-}" | xargs)
    company=$(printf '%s' "${fields[2]:-}" | xargs)
    role=$(printf '%s' "${fields[3]:-}" | xargs)

    [[ -z "$url" ]] && continue

    # Collect fields 4+ as enrichment tags string
    local tags=""
    for (( i=4; i<${#fields[@]}; i++ )); do
      local t
      t=$(printf '%s' "${fields[$i]}" | xargs)
      [[ -n "$t" ]] && tags="$tags $t"
    done
    tags=$(printf '%s' "$tags" | xargs)

    ENTRY_DATES+=("$date")
    ENTRY_URLS+=("$url")
    ENTRY_COMPANIES+=("$company")
    ENTRY_ROLES+=("$role")
    ENTRY_TAGS+=("$tags")
  done < "$PIPELINE_FILE"
}

# ── Worker ────────────────────────────────────────────────────────────────────

run_worker() {
  local idx="$1"
  local url="${ENTRY_URLS[$idx]}"
  local company="${ENTRY_COMPANIES[$idx]}"
  local role="${ENTRY_ROLES[$idx]}"
  local date="${ENTRY_DATES[$idx]}"
  local tags="${ENTRY_TAGS[$idx]}"

  local log_file="$LOGS_DIR/score-pipeline-${RUN_ID}-${idx}.log"
  local result_file="$STATE_DIR/${idx}.result"
  local meta_file="$STATE_DIR/${idx}.meta"

  # Write meta for main process (tab-separated: date url company role tags)
  printf '%s\t%s\t%s\t%s\t%s\n' "$date" "$url" "$company" "$role" "$tags" > "$meta_file"

  # Resolve prompt placeholders
  local resolved="$STATE_DIR/.resolved-${idx}.md"
  local esc_url esc_company esc_role esc_tags
  esc_url=$(printf '%s' "$url"     | sed 's|[\\&]|\\&|g; s|/|\\/|g')
  esc_company=$(printf '%s' "$company" | sed 's|[\\&/]|\\&|g')
  esc_role=$(printf '%s' "$role"    | sed 's|[\\&/]|\\&|g')
  esc_tags=$(printf '%s' "$tags"    | sed 's|[\\&/]|\\&|g')
  local today
  today=$(date +%Y-%m-%d)

  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{ID}}|${idx}|g" \
    -e "s|{{COMPANY}}|${esc_company}|g" \
    -e "s|{{ROLE}}|${esc_role}|g" \
    -e "s|{{DATE}}|${today}|g" \
    -e "s|{{ENRICH_TAGS}}|${esc_tags}|g" \
    "$PROMPT_TEMPLATE" > "$resolved"

  local exit_code=0
  claude -p \
    --bare \
    --dangerously-skip-permissions \
    --append-system-prompt-file "$resolved" \
    "Score this job URL against the candidate CV. Output ONLY the JSON block." \
    > "$log_file" 2>&1 || exit_code=$?

  rm -f "$resolved"

  if [[ $exit_code -ne 0 ]]; then
    local err
    err=$(tail -3 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-120 | sed 's/"/\\"/g')
    printf '{"status":"failed","score":null,"decision":"error","reason_tags":[],"error":"%s"}\n' "$err" \
      > "$result_file"
    return 0
  fi

  # Extract the last JSON object from the log
  local json
  json=$(awk '
    /^\s*\{/ { found=1; block="" }
    found    { block = block $0 "\n" }
    /^\s*\}/ { if (found) { last=block; found=0 } }
    END      { if (last != "") printf "%s", last }
  ' "$log_file" 2>/dev/null | tr -d '\n' || true)

  # Fallback: single-line grep
  if [[ -z "$json" ]]; then
    json=$(grep -o '{.*}' "$log_file" 2>/dev/null | tail -1 || true)
  fi

  if [[ -z "$json" ]]; then
    printf '{"status":"failed","score":null,"decision":"error","reason_tags":[],"error":"no JSON in output"}\n' \
      > "$result_file"
  else
    printf '%s\n' "$json" > "$result_file"
  fi
}

# ── JSON helpers ──────────────────────────────────────────────────────────────

# Extract a scalar JSON field (string or number) from a file
json_get() {
  local file="$1" field="$2"
  # String: "field": "value"
  grep -o "\"${field}\":[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null \
    | sed "s/\"${field}\":[[:space:]]*\"\(.*\)\"/\1/" | head -1 \
    && return
  # Number: "field": 3.8
  grep -o "\"${field}\":[[:space:]]*[0-9][0-9.]*" "$file" 2>/dev/null \
    | sed "s/\"${field}\":[[:space:]]*//" | head -1 \
    || printf ''
}

# Extract a JSON array field and join values with commas
json_arr() {
  local file="$1" field="$2"
  grep -o "\"${field}\":[[:space:]]*\[[^]]*\]" "$file" 2>/dev/null \
    | sed "s/\"${field}\":[[:space:]]*\[//" \
    | sed 's/\]//' \
    | tr -d '"' \
    | sed 's/^[[:space:],]*//' \
    | sed 's/[[:space:],]*$//' \
    | tr -s ', ' ',' \
    | head -1 \
    || printf ''
}

# ── Build output line ─────────────────────────────────────────────────────────

# Construct the replacement pipeline line for a given entry index.
build_line() {
  local idx="$1"
  local prescreen="${2:-}"

  local meta_file="$STATE_DIR/${idx}.meta"
  local result_file="$STATE_DIR/${idx}.result"

  local date url company role
  IFS=$'\t' read -r date url company role _ < "$meta_file"

  if [[ -n "$prescreen" ]]; then
    printf -- '- [x] %s | %s | %s | %s | -/5 | hold | %s' \
      "$date" "$url" "$company" "$role" "$prescreen"
    return
  fi

  if [[ ! -f "$result_file" ]]; then
    printf -- '- [!] %s | %s | %s | %s — Error: result file missing' \
      "$date" "$url" "$company" "$role"
    return
  fi

  local status decision score reason_tags error_msg worker_company worker_role
  status=$(json_get "$result_file" "status")
  decision=$(json_get "$result_file" "decision")
  score=$(json_get "$result_file" "score")
  reason_tags=$(json_arr "$result_file" "reason_tags")
  error_msg=$(json_get "$result_file" "error")
  worker_company=$(json_get "$result_file" "company")
  worker_role=$(json_get "$result_file" "role")

  # Use worker-provided company/role if they look valid (non-empty, not placeholder)
  [[ -n "$worker_company" && "$worker_company" != "{{COMPANY}}" ]] && company="$worker_company"
  [[ -n "$worker_role"    && "$worker_role"    != "{{ROLE}}"    ]] && role="$worker_role"

  if [[ "$status" == "failed" ]]; then
    printf -- '- [!] %s | %s | %s | %s — Error: %s' \
      "$date" "$url" "$company" "$role" "${error_msg:-unknown}"
    return
  fi

  local score_str="${score:-?}/5"
  printf -- '- [x] %s | %s | %s | %s | %s | %s | %s' \
    "$date" "$url" "$company" "$role" \
    "$score_str" "${decision:-hold}" "${reason_tags:-(none)}"
}

# ── Pipeline file rewrite ─────────────────────────────────────────────────────

# Rewrite the pipeline file, replacing lines for each index in the given file.
# $1 = file with one index per line; $2 = label for temp files
apply_to_pipeline() {
  local indices_file="$1"
  local label="$2"
  local map_file="$STATE_DIR/map-${label}.tsv"

  > "$map_file"
  while IFS= read -r idx; do
    [[ -z "$idx" ]] && continue
    local prescreen=""
    [[ -f "$STATE_DIR/${idx}.prescreen" ]] && prescreen=$(cat "$STATE_DIR/${idx}.prescreen")
    local new_line
    new_line=$(build_line "$idx" "$prescreen")
    local url="${ENTRY_URLS[$idx]}"
    # Write: URL <TAB> new_line
    printf '%s\t%s\n' "$url" "$new_line" >> "$map_file"
  done < "$indices_file"

  local tmp="$PIPELINE_FILE.score-tmp"
  awk -v mapfile="$map_file" '
BEGIN {
  while ((getline line < mapfile) > 0) {
    sep = index(line, "\t")
    url = substr(line, 1, sep - 1)
    repl[url] = substr(line, sep + 1)
  }
  close(mapfile)
}
{
  replaced = 0
  if ($0 ~ /^- \[ \]/) {
    for (url in repl) {
      if (index($0, url) > 0) {
        print repl[url]
        replaced = 1
        break
      }
    }
  }
  if (!replaced) print
}
' "$PIPELINE_FILE" > "$tmp" && mv "$tmp" "$PIPELINE_FILE"
}

# ── Tracker queue ─────────────────────────────────────────────────────────────

enqueue_qualified() {
  local idx="$1"
  local result_file="$STATE_DIR/${idx}.result"
  [[ ! -f "$result_file" ]] && return

  local status score
  status=$(json_get "$result_file" "status")
  score=$(json_get "$result_file" "score")

  [[ "$status" != "qualified" ]] && return
  [[ -z "$score" ]] && return

  # Score gate
  if ! awk -v s="$score" -v m="$MIN_SCORE" 'BEGIN { exit (s >= m ? 0 : 1) }'; then
    return
  fi

  local meta_file="$STATE_DIR/${idx}.meta"
  local date url company role
  IFS=$'\t' read -r date url company role _ < "$meta_file"

  local worker_company worker_role
  worker_company=$(json_get "$result_file" "company")
  worker_role=$(json_get "$result_file" "role")
  [[ -n "$worker_company" && "$worker_company" != "{{COMPANY}}" ]] && company="$worker_company"
  [[ -n "$worker_role"    && "$worker_role"    != "{{ROLE}}"    ]] && role="$worker_role"

  local reason_tags
  reason_tags=$(json_arr "$result_file" "reason_tags")

  local notes="${reason_tags:-} NEXT[pdf=pending;custom_resume=pending;cv_changes=pending;interview_prep=pending]"
  notes=$(printf '%s' "$notes" | xargs)

  # Write tracker TSV (num=0 → merge-tracker.mjs auto-assigns)
  mkdir -p "$TRACKER_ADDITIONS_DIR"
  printf '0\t%s\t%s\t%s\tScored\t%s/5\t❌\t-\t%s\n' \
    "$date" "$company" "$role" "$score" "$notes" \
    > "$TRACKER_ADDITIONS_DIR/score-pipeline-${RUN_ID}-${idx}.tsv"

  # Add to followup-queue if at or above follow-up threshold
  if awk -v s="$score" -v t="$FOLLOWUP_THRESHOLD" 'BEGIN { exit (s >= t ? 0 : 1) }'; then
    if [[ -f "$FOLLOWUP_QUEUE" ]] && ! grep -qF "$url" "$FOLLOWUP_QUEUE" 2>/dev/null; then
      local today
      today=$(date +%Y-%m-%d)
      printf 'sp-%s\t%s\t%s\t%s\t%s\t%s\tpending\tpending\tpending\tpending\tqueued-from-score-pipeline\n' \
        "$idx" "$today" "$score" "$company" "$role" "$url" >> "$FOLLOWUP_QUEUE"
    fi
  fi
}

# ── Move processed entries out of Pending section ─────────────────────────────

# Moves all [x] and [~] lines from ## Pending into ## Processed.
# Keeps [ ] and [!] lines in Pending. Creates ## Processed section if missing.
promote_processed() {
  local tmp="$PIPELINE_FILE.promote-tmp"
  awk '
    BEGIN { in_pending=0; found_processed=0; promoted="" }
    /^## Pending/   { in_pending=1; print; next }
    /^## Processed/ {
      in_pending=0; found_processed=1
      print
      if (promoted != "") { printf "%s", promoted; promoted="" }
      next
    }
    in_pending && /^- \[[x~]\]/ { promoted = promoted $0 "\n"; next }
    { print }
    END {
      if (!found_processed && promoted != "") {
        print "\n## Processed"
        printf "%s", promoted
      }
    }
  ' "$PIPELINE_FILE" > "$tmp" && mv "$tmp" "$PIPELINE_FILE"
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
  local n_advance=0 n_hold=0 n_error=0 n_prescreen=0
  local score_sum="0" score_count=0
  local -a qualified=()

  for f in "$STATE_DIR"/*.prescreen; do
    [[ -f "$f" ]] || break
    n_prescreen=$(( n_prescreen + 1 ))
  done

  for f in "$STATE_DIR"/*.result; do
    [[ -f "$f" ]] || break
    local idx status score
    idx=$(basename "$f" .result)
    status=$(json_get "$f" "status")
    score=$(json_get "$f" "score")
    case "$status" in
      qualified)
        n_advance=$(( n_advance + 1 ))
        if [[ -n "$score" ]]; then
          score_sum=$(awk -v a="$score_sum" -v b="$score" 'BEGIN { printf "%.2f", a+b }')
          score_count=$(( score_count + 1 ))
        fi
        if awk -v s="${score:-0}" -v m="$MIN_SCORE" 'BEGIN { exit (s >= m ? 0 : 1) }' 2>/dev/null; then
          qualified+=("$idx")
        fi
        ;;
      skipped) n_hold=$(( n_hold + 1 )) ;;
      failed)  n_error=$(( n_error + 1 )) ;;
    esac
  done

  echo ""
  echo "=== Score Pipeline Summary ==="
  printf '  Pre-screened (hold, no fetch):  %d\n' "$n_prescreen"
  printf '  Scored advance (>= %s/5):       %d\n' "$MIN_SCORE" "$n_advance"
  printf '  Scored hold:                    %d\n' "$n_hold"
  printf '  Errors:                         %d\n' "$n_error"

  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v s="$score_sum" -v n="$score_count" 'BEGIN { printf "%.1f", s/n }')
    printf '  Avg score (advance): %s/5 (%d jobs)\n' "$avg" "$score_count"
  fi

  if (( ${#qualified[@]} > 0 )); then
    echo ""
    echo "--- Qualified offers (added to tracker) ---"
    for idx in "${qualified[@]}"; do
      local f="$STATE_DIR/${idx}.result"
      local mf="$STATE_DIR/${idx}.meta"
      [[ -f "$mf" ]] || continue
      local company role score reason_tags
      IFS=$'\t' read -r _ _ company role _ < "$mf"
      local wc wr
      wc=$(json_get "$f" "company"); [[ -n "$wc" && "$wc" != "{{COMPANY}}" ]] && company="$wc"
      wr=$(json_get "$f" "role");    [[ -n "$wr" && "$wr" != "{{ROLE}}"    ]] && role="$wr"
      score=$(json_get "$f" "score")
      reason_tags=$(json_arr "$f" "reason_tags")
      printf '  %-30s | %-42s | %s/5 | %s\n' \
        "${company:0:30}" "${role:0:42}" "$score" "$reason_tags"
    done
    echo ""
    echo "Run follow-up actions:"
    echo "  node batch/followup-queue.mjs list --pending"
    echo "  ./batch/on-demand-runner.sh --id <id> --action pdf"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  [[ ! -f "$PIPELINE_FILE" ]] && { echo "ERROR: Pipeline file not found: $PIPELINE_FILE"; exit 1; }
  [[ ! -f "$PROMPT_TEMPLATE" ]] && { echo "ERROR: Worker prompt not found: $PROMPT_TEMPLATE"; exit 1; }
  command -v claude &>/dev/null || { echo "ERROR: 'claude' CLI not found in PATH"; exit 1; }

  mkdir -p "$LOGS_DIR" "$TRACKER_ADDITIONS_DIR" "$STATE_DIR"

  [[ "$DRY_RUN" == "false" ]] && acquire_lock

  echo "=== career-ops score-pipeline ==="
  echo "File:       $PIPELINE_FILE"
  printf 'Parallel: %d | Batch: %d | Min score: %s\n' "$PARALLEL" "$BATCH_SIZE" "$MIN_SCORE"
  [[ "$MAX_EXP" -gt 0 ]] && echo "Pre-screen: exp > $MAX_EXP"
  echo ""

  parse_pipeline
  local total=${#ENTRY_URLS[@]}

  if (( total == 0 )); then
    echo "No pending [ ] entries found in $PIPELINE_FILE."
    exit 0
  fi
  echo "Found $total pending entries"

  # Phase 1 — pre-screen
  local -a to_fetch=()
  local -a prescreen_indices=()
  for (( i=0; i<total; i++ )); do
    local reason
    reason=$(prescreen_reason "${ENTRY_TAGS[$i]}")
    if [[ -n "$reason" ]]; then
      printf '%s' "$reason" > "$STATE_DIR/${i}.prescreen"
      prescreen_indices+=("$i")
      if [[ "$DRY_RUN" == "true" ]]; then
        printf '  [SKIP] %-48s %s\n' "${ENTRY_URLS[$i]:0:48}" "$reason"
      fi
    else
      to_fetch+=("$i")
    fi
  done

  if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "=== DRY RUN — no fetches or writes ==="
    printf 'Pre-screened: %d  |  Would fetch+score: %d\n' \
      "${#prescreen_indices[@]}" "${#to_fetch[@]}"
    echo ""
    for idx in "${to_fetch[@]}"; do
      printf '  [SCORE] %-30s | %-40s\n' \
        "${ENTRY_COMPANIES[$idx]}" "${ENTRY_ROLES[$idx]:0:40}"
      printf '          %s\n' "${ENTRY_URLS[$idx]}"
    done
    exit 0
  fi

  echo "Pre-screened: ${#prescreen_indices[@]} | To fetch: ${#to_fetch[@]}"
  echo ""

  # Phase 2 — batch parallel scoring
  local total_fetch=${#to_fetch[@]}
  local batch_num=0
  local fetched=0

  for (( b=0; b<total_fetch; b+=BATCH_SIZE )); do
    batch_num=$(( batch_num + 1 ))
    local end=$(( b + BATCH_SIZE ))
    (( end > total_fetch )) && end=$total_fetch
    local -a batch=("${to_fetch[@]:$b:$(( end - b ))}")
    local batch_count=${#batch[@]}

    echo "--- Batch ${batch_num}: entries $(( b+1 ))-${end} of ${total_fetch} ---"

    # Launch parallel workers, cap at PARALLEL
    local -a pids=()
    local -a pid_idxs=()
    local running=0

    for idx in "${batch[@]}"; do
      # Wait if at capacity
      while (( running >= PARALLEL )); do
        local i
        for (( i=0; i<${#pids[@]}; i++ )); do
          if [[ -n "${pids[$i]:-}" ]] && ! kill -0 "${pids[$i]}" 2>/dev/null; then
            wait "${pids[$i]}" 2>/dev/null || true
            local done_idx="${pid_idxs[$i]}"
            fetched=$(( fetched + 1 ))
            printf '    [%d/%d] done: %s | %s\n' \
              "$fetched" "$total_fetch" \
              "${ENTRY_COMPANIES[$done_idx]}" "${ENTRY_ROLES[$done_idx]}"
            pids[$i]=""
            pid_idxs[$i]=""
            running=$(( running - 1 ))
          fi
        done
        # Compact arrays to remove empty slots
        local -a new_pids=() new_idxs=()
        for (( i=0; i<${#pids[@]}; i++ )); do
          [[ -n "${pids[$i]:-}" ]] && { new_pids+=("${pids[$i]}"); new_idxs+=("${pid_idxs[$i]}"); }
        done
        pids=("${new_pids[@]+"${new_pids[@]}"}")
        pid_idxs=("${new_idxs[@]+"${new_idxs[@]}"}")
        (( running > 0 )) && sleep 1
      done

      printf '  → %s | %s\n' "${ENTRY_COMPANIES[$idx]}" "${ENTRY_ROLES[$idx]}"
      run_worker "$idx" &
      pids+=($!)
      pid_idxs+=("$idx")
      running=$(( running + 1 ))
    done

    # Drain remaining workers
    for (( i=0; i<${#pids[@]}; i++ )); do
      [[ -z "${pids[$i]:-}" ]] && continue
      wait "${pids[$i]}" 2>/dev/null || true
      local done_idx="${pid_idxs[$i]}"
      fetched=$(( fetched + 1 ))
      printf '    [%d/%d] done: %s | %s\n' \
        "$fetched" "$total_fetch" \
        "${ENTRY_COMPANIES[$done_idx]}" "${ENTRY_ROLES[$done_idx]}"
    done

    # Queue tracker TSV FIRST — ensures advances persist even if pipeline rewrite crashes
    for idx in "${batch[@]}"; do
      enqueue_qualified "$idx"
    done

    # Write batch results to pipeline file (after TSV is safe)
    printf '%s\n' "${batch[@]}" > "$STATE_DIR/batch-${batch_num}-indices.txt"
    echo "  Writing batch $batch_num to pipeline file..."
    apply_to_pipeline "$STATE_DIR/batch-${batch_num}-indices.txt" "batch-${batch_num}"

    echo "  Batch $batch_num complete."
    echo ""
  done

  # Write pre-screened results to pipeline file (at end, after all fetch batches)
  if (( ${#prescreen_indices[@]} > 0 )); then
    echo "--- Writing pre-screened results to pipeline file ---"
    printf '%s\n' "${prescreen_indices[@]}" > "$STATE_DIR/prescreen-indices.txt"
    apply_to_pipeline "$STATE_DIR/prescreen-indices.txt" "prescreen"
    echo ""
  fi

  # Move all [x] and [~] entries from ## Pending to ## Processed
  echo "--- Promoting processed entries to ## Processed ---"
  promote_processed
  echo ""

  # Merge tracker additions into applications.md
  local tsv_count
  tsv_count=$(find "$TRACKER_ADDITIONS_DIR" -name "score-pipeline-${RUN_ID}-*.tsv" 2>/dev/null | wc -l | tr -d ' ')
  if (( tsv_count > 0 )); then
    echo "=== Merging $tsv_count tracker additions ==="
    cd "$PROJECT_DIR"
    node merge-tracker.mjs
    echo ""
  fi

  print_summary

  # Clean up state dir
  rm -rf "$STATE_DIR"
}

cd "$PROJECT_DIR"
main "$@"
