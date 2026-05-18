package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func TestParseApplicationsUsesTrackerNumberColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-04-16 | Arize AI | AI Engineer, Instrumentation | 4.7/5 | Evaluated | ✅ | [140](reports/140-arize-ai-engineer-instrumentation-2026-04-16.md) | Strong fit |
| 143 | 2026-04-16 | Arize AI | AI Sales Engineer, US | 4.1/5 | Evaluated | ❌ | [143](reports/143-arize-ai-sales-engineer-us-2026-04-16.md) | Good fit |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].Number != 140 {
		t.Fatalf("expected first application number to be 140, got %d", apps[0].Number)
	}
	if apps[1].Number != 143 {
		t.Fatalf("expected second application number to be 143, got %d", apps[1].Number)
	}
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers to stay aligned with tracker IDs, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
}

func TestNormalizeStatusUsesLatestHistoryToken(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "single", raw: "Scored", want: "scored"},
		{name: "history latest applied", raw: "Scored > PDF'd > Applied", want: "applied"},
		{name: "history latest pdf", raw: "Scored > PDF'd", want: "pdf"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeStatus(tc.raw); got != tc.want {
				t.Fatalf("NormalizeStatus(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestUpdateApplicationStatusAppendsHistory(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 41 | 2026-05-11 | ElevenLabs | Full-Stack Engineer | 4.3/5 | Scored | ❌ | - | NEXT[pdf=pending] |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	app := model.CareerApplication{Number: 41, Status: "Scored"}
	if err := UpdateApplicationStatus(tempDir, app, "PDF'd"); err != nil {
		t.Fatalf("UpdateApplicationStatus failed: %v", err)
	}

	app.Status = "Scored > PDF'd"
	if err := UpdateApplicationStatus(tempDir, app, "Applied"); err != nil {
		t.Fatalf("UpdateApplicationStatus second update failed: %v", err)
	}

	updated, err := os.ReadFile(applicationsPath)
	if err != nil {
		t.Fatalf("failed to read updated applications tracker: %v", err)
	}

	content := string(updated)
	if want := "Scored > PDF'd > Applied"; !strings.Contains(content, want) {
		t.Fatalf("expected status history %q in tracker, got:\n%s", want, content)
	}
}
