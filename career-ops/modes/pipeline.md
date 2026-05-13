# Mode: pipeline — Legacy Alias

`/career-ops pipeline` is kept for backward compatibility and maps to:

- `/career-ops score discovery`

Use `score` mode for current behavior:

- Reads pending URLs from queue
- Extracts JD content
- Scores CV vs JD only
- Adds to tracker only if score >= 3.5
- Does not create reports or PDFs in this stage

See `modes/score.md` for the canonical workflow.
