package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

type viewState int

const (
	viewPipeline viewState = iota
	viewReport
	viewProgress
	viewScanning // running node scan-playwright.mjs
)

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	state           viewState
	careerOpsPath   string
	theme           theme.Theme
	progressMetrics model.ProgressMetrics
	scanningCompany string
}

func (m *appModel) reloadPipelineData() {
	apps := data.ParseApplications(m.careerOpsPath)
	metrics := data.ComputeMetrics(apps)
	m.progressMetrics = data.ComputeProgressMetrics(apps)
	m.pipeline = m.pipeline.WithReloadedData(apps, metrics)
}

func (m appModel) Init() tea.Cmd {
	return nil
}

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.pipeline.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		if m.state == viewProgress {
			m.progress.Resize(msg.Width, msg.Height)
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineClosedMsg:
		return m, tea.Quit

	case screens.PipelineLoadReportMsg:
		archetype, tldr, remote, comp := data.LoadReportSummary(msg.CareerOpsPath, msg.ReportPath)
		m.pipeline.EnrichReport(msg.ReportPath, archetype, tldr, remote, comp)
		return m, nil

	case screens.PipelineUpdateStatusMsg:
		err := data.UpdateApplicationStatus(msg.CareerOpsPath, msg.App, msg.NewStatus)
		if err != nil {
			// Log the error but still reload data to keep UI consistent
			fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
		}
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineRefreshMsg:
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			m.theme,
			msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewReport
		return m, nil

	case screens.PipelineOpenNotesMsg:
		m.viewer = screens.NewViewerModelFromContent(
			m.theme,
			msg.Lines, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineOpenProgressMsg:
		m.progress = screens.NewProgressModel(
			theme.NewTheme("catppuccin-mocha"),
			m.progressMetrics,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewProgress
		return m, nil

	case screens.ProgressClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineRescanMsg:
		m.state = viewScanning
		m.scanningCompany = fmt.Sprintf("#%d %s", msg.EntryNumber, msg.CompanyName)
		path := msg.CareerOpsPath
		id := fmt.Sprintf("%d", msg.EntryNumber)
		return m, func() tea.Msg {
			cmd := exec.Command("node", "re-eval.mjs", "--id", id, "--update-status")
			cmd.Dir = path
			out, err := cmd.CombinedOutput()
			output := string(out)
			if err != nil {
				output += "\n\nExit error: " + err.Error()
			}
			return screens.PipelineRescanDoneMsg{CompanyName: msg.CompanyName, Output: output}
		}

	case screens.PipelineRescanDoneMsg:
		m.scanningCompany = ""
		lines := strings.Split(msg.Output, "\n")
		title := fmt.Sprintf("Rescan: %s", msg.CompanyName)
		m.viewer = screens.NewViewerModelFromContent(
			m.theme, lines, title,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewReport
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineRunInputMsg:
		m.state = viewScanning
		m.scanningCompany = msg.Input
		path := msg.CareerOpsPath
		input := strings.TrimSpace(msg.Input)
		return m, func() tea.Msg {
			var (
				args   []string
				script string
				label  string
			)

			// Numeric ID → pdf-from-id.mjs
			isID := true
			for _, ch := range input {
				if ch < '0' || ch > '9' {
					isID = false
					break
				}
			}
			if isID && len(input) > 0 {
				script = "pdf-from-id.mjs"
				args = []string{"--id", input}
				label = fmt.Sprintf("PDF from ID #%s", input)
			} else if strings.HasPrefix(strings.ToLower(input), "http") {
				// URL → decide between playwright scan and ingest
				// Heuristics: a "listing" URL has search/results/jobs? patterns → scan-playwright.mjs --url
				// A specific job URL (contains /job/<id> or /job_details/) → ingest-urls.mjs
				isListing := false
				listingPatterns := []string{"/search", "/results", "/jobs?", "/jobs/", "?q=", "?query=", "?keywords=", "/jobsearch", "job-boards.greenhouse.io", "boards.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co"}
				jobPatterns := []string{"/job_details/", "/careers/job/", "/jobs/view/", "gh_jid=", "jobid=", "/profile/job_details/"}
				lowerInput := strings.ToLower(input)
				for _, p := range jobPatterns {
					if strings.Contains(lowerInput, p) {
						isListing = false
						break
					}
				}
				for _, p := range listingPatterns {
					if strings.Contains(lowerInput, p) {
						isListing = true
						break
					}
				}
				if isListing {
					script = "scan-playwright.mjs"
					args = []string{"--url", input}
					label = "URL scan: " + input
				} else {
					script = "ingest-urls.mjs"
					// ingest-urls.mjs reads from tmp/ingest-urls.txt, write URL there first
					ingestFile := path + "/tmp/ingest-urls.txt"
					_ = os.MkdirAll(path+"/tmp", 0o755)
					_ = os.WriteFile(ingestFile, []byte(input+"\n"), 0o644)
					args = []string{"--no-fetch-titles"}
					label = "Ingest: " + input
				}
			} else {
				return screens.PipelineRescanDoneMsg{
					CompanyName: input,
					Output:      "Invalid input: enter a URL (https://...) or a tracker number (e.g. 42)",
				}
			}

			cmd := exec.Command("node", append([]string{script}, args...)...)
			cmd.Dir = path
			out, err := cmd.CombinedOutput()
			output := label + "\n" + strings.Repeat("─", 60) + "\n" + string(out)
			if err != nil {
				output += "\n\nExit error: " + err.Error()
			}
			return screens.PipelineRescanDoneMsg{CompanyName: input, Output: output}
		}

	case screens.PipelineOpenURLMsg:
		url := msg.URL
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", url)
			case "linux":
				cmd = exec.Command("xdg-open", url)
			case "windows":
				cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
			default:
				cmd = exec.Command("xdg-open", url)
			}
			_ = cmd.Run()
			return nil
		}

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		if m.state == viewProgress {
			pg, cmd := m.progress.Update(msg)
			m.progress = pg
			return m, cmd
		}
		if m.state == viewScanning {
			// Block input while scan is running
			return m, nil
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd
	}
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	case viewScanning:
		return fmt.Sprintf("\n\n   Re-evaluating %s\n\n   Running: node re-eval.mjs --id %s\n   Scraping job page + Gemini evaluation in progress...\n\n   Please wait (30\u201390s). Results will appear automatically.\n",
			m.scanningCompany, m.scanningCompany)
	default:
		return m.pipeline.View()
	}
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	flag.Parse()

	careerOpsPath := *pathFlag

	// Load applications
	apps := data.ParseApplications(careerOpsPath)
	if apps == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find applications.md in %s or %s/data/\n", careerOpsPath, careerOpsPath)
		os.Exit(1)
	}

	// Compute metrics
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps)

	// Batch-load all report summaries
	t := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(t, apps, metrics, careerOpsPath, 120, 40)

	for _, app := range apps {
		if app.ReportPath == "" {
			continue
		}
		archetype, tldr, remote, comp := data.LoadReportSummary(careerOpsPath, app.ReportPath)
		if archetype != "" || tldr != "" || remote != "" || comp != "" {
			pm.EnrichReport(app.ReportPath, archetype, tldr, remote, comp)
		}
	}

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           t,
		progressMetrics: progressMetrics,
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
