# Article & Project Digest — Shram Kadia

## Experience

### OpenPRA Org — Software Engineer
**Duration:** Aug 2025 – Present
**Stack:** Python, TypeScript, Node.js, Docker, Jest, AWS, CI/CD

Owned end-to-end delivery of a probabilistic fault-tree generator for nuclear safety analysis,
shipped from concept to production in 8 weeks. Covered 10+ nuclear failure scenarios with
type-safe probability classes across Python and TypeScript. Authored 25+ Jest unit tests and
CI checks guaranteeing numerical stability and 100% coverage on safety-critical probability
calculations. Redesigned the XML processing pipeline with lazy-parse techniques, cutting
debugging cycles by 40%. Designed an autonomous evaluation agent that self-verifies results
across 25 scenarios with zero manual intervention.

**Key metrics:** 8-week concept-to-production, 10+ failure scenarios, 25+ test cases, 40% reduction
in debugging cycles, 100% CI coverage on safety-critical outputs.

---

### NC State University — Backend Engineer / Research Assistant
**Duration:** Jul 2024 – Mar 2025
**Stack:** Python, LangChain, FAISS, HuggingFace, FastAPI, Redis, GCP, distributed tracing

Eliminated 60% of manual literature extraction by integrating LangChain AI agents with a
FAISS RAG pipeline ingesting 200+ scientific PDFs, deployed as a FastAPI microservice on GCP.
Built production RAG stack with semantic chunking, HuggingFace sentence-transformers, Redis
embedding cache, exponential-backoff retry, and cosine-similarity confidence thresholds as a
retrieval quality gate. Achieved 85% extraction accuracy and sub-200ms latency under concurrent
load. Instrumented the system with distributed tracing, structured logs, and drift monitoring;
used telemetry and latency metrics to drive a 30% throughput improvement. Saved the department
30 hours/week by enabling instant querying over unstructured research data.

**Key metrics:** 200+ PDFs ingested, 85% extraction accuracy, sub-200ms latency, 60% reduction
in manual extraction, 30% throughput improvement, 30 hrs/week saved.

---

### Resilient Tech — Software Engineer
**Duration:** Jan 2023 – May 2023
**Stack:** Python, React, MariaDB, PostgreSQL, ERPNext, Frappe, REST APIs

Migrated critical ERP systems to RESTful Python APIs across 5 enterprise rollouts, cutting
production downtime by 30% and sustaining 99% uptime through targeted security audits.
Resolved 100+ production support tickets by tracing root causes through full-stack workflows,
modularizing code, and refactoring debugging processes — lifting CSAT by 12%. Architected
MariaDB and PostgreSQL integrations across 5 ERPNext deployments, enabling client-specific
module configurations. Built and maintained client-facing React interfaces alongside Python
backend APIs with Git and Agile workflows.

**Key metrics:** 5 enterprise rollouts, 30% downtime reduction, 99% uptime, 100+ tickets resolved,
12% CSAT improvement.

---

## Projects

### Restaurant Voice Hub
**URL:** https://github.com/Shram007/restaurant-voice-hub
**Stack:** ElevenLabs Conversational AI, FastAPI, PostgreSQL, Vercel, Render, MCP (JSON-RPC 2.0)

Architected a production-grade agentic orchestration layer with 5 callable tools inside
ElevenLabs Conversational AI, enabling fully autonomous end-to-end voice ordering with no
human handoff. Exposed all 5 tool endpoints as MCP-callable tools via a stdio JSON-RPC 2.0
MCP server, making the backend interoperable with any MCP-compatible AI client. Engineered a
real-time CSV knowledge-injection pipeline syncing live PostgreSQL inventory to the agent
catalog, cutting menu update time from hours to seconds with zero redeployment. Deployed
multi-tenant architecture scoped by restaurant_id across Vercel and Render, ready to scale
across tenants with no architectural changes. Implemented end-to-end request tracing and error
logging across all FastAPI service layers.

**Key metrics:** 5-tool agentic backend, zero human handoff, multi-tenant production deploy,
menu updates reduced from hours to seconds.

---

### ClinicFlow
**URL:** https://github.com/Shram007/Clinicflow
**Stack:** Python, FastAPI, STT, LLM, TTS, Docker, CI/CD, JSON schema enforcement, MCP

Built a three-stage speech-to-structured-data pipeline converting doctor voice recordings into
SOAP notes via STT → LLM agent → TTS, with audio readback in a single click. Enforced
JSON-only structured output across 6 clinical keys with graceful fallback on parse failure and
explicit quality controls for non-deterministic LLM outputs in a safety-critical medical context.
Implemented a stdio JSON-RPC 2.0 MCP server with 3 tools (initialize handshake, tools/list,
tools/call), structured error codes, and 5 protocol-layer unit tests. Developed a prompt
versioning system and LLM-as-judge evaluation pipeline scoring outputs for clinical accuracy,
with per-request latency, token usage, and error rate instrumentation. Configured Docker
containerization and CI/CD for all three pipeline services.

**Key metrics:** 6 clinical output keys, zero silent failures, full MCP server implementation,
per-request observability across all layers.

---

### Travel Agent ATLAS
**URL:** https://github.com/Shram007/Travel-Agent
**Stack:** Python, LangChain, unified OpenAI-compatible proxy, Exa neural search, ReAct agent loop

Built runtime LLM switching across 4 models (Gemini 2.5 Pro, DeepSeek-R1, Llama 3.3-70B,
Qwen 2.5-72B) via a unified OpenAI-compatible proxy, tracking per-request token usage and cost
at runtime to enable live cost/performance tradeoffs without redeployment. Fired parallel Exa
neural search queries for destinations, hotels, and flights before each LLM call, eliminating
retrieval latency from the critical path and grounding responses in live web data. Deployed a
ReAct reasoning loop parsing tool_call blocks from LLM output, dispatching via a unified tool
router, injecting observations back into conversation history, and iterating up to 3 steps before
returning a final answer.

**Key metrics:** 4 LLMs orchestrated, runtime cost tracking, parallel neural search, full ReAct
loop implementation.

---

## Additional Projects
<!-- priority: low — kept for completeness, deprioritize in evaluations vs. primary projects above -->

### E-Learning Course Management System
**URL:** https://github.com/Shram007/Course-Management-System
**Stack:** Python, MySQL, REST APIs, object-oriented architecture

Engineered a course management platform with a MySQL backend and 4 user roles (Admin,
Faculty, TA, Student), supporting 50+ operations for enrollment, textbook management, and
assessments. Designed an object-oriented Python architecture with CRUD abstractions over User,
Course, Enrollment, and Content entities. Optimized complex SQL queries using joins,
aggregations, and subqueries (waitlists, faculty loads, engagement metrics) with connection
pooling to sustain concurrent usage.

**Key metrics:** 4 user roles, 50+ supported operations, concurrent usage via connection pooling.

---

### Redesigning Residual Connections (Research)
**Stack:** PyTorch, ResNet, VGG-16, AlexNet, CIFAR-10, Matplotlib

Implemented and evaluated baseline, linear, and polynomial skip connections across ResNet,
VGG-16, and AlexNet on CIFAR-10. Analyzed class-wise accuracy and gradient flow patterns,
revealing up to 3x gradient spikes in polynomial connections and 5–10% higher validation
accuracy with standard residual blocks. Visualized convergence behavior and layer-wise
activations to demonstrate architectural tradeoffs for deeper model interpretability.

**Key metrics:** 3 architectures compared, 3x gradient spike finding, 5–10% accuracy delta documented.

---

### Movie Recommendation System
**Stack:** Python, collaborative filtering, matrix factorization

Modeled user temporal behavior to capture evolving preferences, improving recommendation
precision by 18%. Reduced computation cost by 25% via optimized latent factors and efficient
matrix operations. Analyzed user behavioral datasets using collaborative filtering to generate
data-driven recommendations with tracked performance metrics across iterations.

**Key metrics:** 18% precision improvement, 25% compute cost reduction.

---

### Traffic Sign Detection
**Stack:** Python, CNN, PyTorch, GUI

Delivered 95% accuracy on traffic sign classification using CNN, improving autonomous driving
safety. Built GUI for easy classification of 5,000+ signs.

**Key metrics:** 95% classification accuracy, 5,000+ signs.
