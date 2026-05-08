# Mode: deep - Deep Research Prompt

Generate a structured prompt for Perplexity/Claude/ChatGPT with 6 focus areas:

```
## Deep Research: [Company] - [Role]

Context: I am evaluating a candidacy for [role] at [company]. I need actionable interview intelligence.

### 1. AI strategy
- Which products/features use AI/ML?
- What is their AI stack? (models, infrastructure, tools)
- Do they have an engineering blog? What do they publish?
- Have they published talks or papers on AI?

### 2. Recent moves (last 6 months)
- Relevant AI/ML/product hiring?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Engineering culture
- How do they ship? (deploy cadence, CI/CD)
- Monorepo or multirepo?
- Which languages/frameworks do they use?
- Remote-first or office-first?
- Glassdoor/Blind signals on engineering culture?

### 4. Likely challenges
- What scaling problems are they likely facing?
- Reliability, cost, or latency challenges?
- Are they migrating anything? (infra, models, platforms)
- What pain points show up in reviews?

### 5. Competitors and differentiation
- Who are their main competitors?
- What is their moat/differentiator?
- How are they positioned versus competitors?

### 6. Candidate angle
Given my profile (read from cv.md and profile.yml for specific experience):
- What unique value can I bring to this team?
- Which of my projects are most relevant?
- What story should I tell in the interview?
```

Customize each section using context from the specific evaluated offer.
