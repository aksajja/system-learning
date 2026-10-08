# System Learning Sandbox

System design interview prep, done by building. Each experiment starts the way an interview does (requirements, estimates, API, diagram, data model, deep dives). Then we build only the parts interviewers push on, in Go, so the trade-offs are something you've run and watched rather than memorised. Each experiment ends with an **interview cheat sheet**: the short version to say out loud, plus answers to the usual follow-up questions.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/aksajja/system-learning?quickstart=1)

## Two ways in

- **Reading and learning:** use the site, **System Design Lab** (link: *add after the first Cloudflare deploy*). It has lessons, cheat sheets and lab pages, each with an **Open this lab** button that starts a GitHub Codespace with Go, Claude Code and the ports ready.
- **Building:** each experiment folder's README holds the working notes: what's built, what's next, how to run it, and what we learned along the way.

| Order | Experiment | Status | Lessons |
|---|---|---|---|
| 1 | [load-balancer/](load-balancer/README.md) | Built: backends, reverse proxy, round-robin | [cheat sheet](lessons/load-balancer/cheat-sheet.md), [deep dives](lessons/load-balancer/deep-dives.md), [lab](lessons/load-balancer/lab.mdx) |
| 2 | [rate-limiter/](rate-limiter/README.md) | Planned (next) | none yet |
| 3 | [chat-system/](chat-system/README.md) | Designed, not built | [lessons/chat-system/](lessons/chat-system/) |
| – | [traffic-generator/](traffic-generator/README.md) | Planned | shared tool to drive load |
| – | [misc/](misc/README.md) | Notes only | [lessons/misc/](lessons/misc/): DNS, E2EE, load generation limits |

## Learning with Claude Code

[CLAUDE.md](CLAUDE.md) tells Claude Code how to teach in this repo: one concept per step, the *why* before any code, a pause after each step so you can run it, a "try breaking it" exercise, and links back to interview questions. Run `claude` in the repo (locally or in a Codespace) and try:

- "Let's start the rate limiter. Walk me through Part 1 interview-style."
- "Let's build step 1 of the rate limiter."
- "Quiz me on the load balancer cheat sheet."
- "Design a URL shortener as a new experiment, same structure as the others."

Edit `CLAUDE.md` to match you, e.g. your Go experience or a preferred language.

## Running things

**Labs** need [Go](https://go.dev/dl/) 1.25+ (see `load-balancer/go/go.mod`), or nothing at all in a Codespace. Rust is only for the optional side project in `load-balancer/rust/`.

```sh
cd load-balancer/go
go run ./backend -port 8081 -name a   # also 8082 b, 8083 c, each in its own terminal
go run ./proxy                        # load balancer on :8090
curl localhost:8090                   # repeat: answers rotate across backends
```

In VS Code or a Codespace, *Run Task → Load balancer lab: start all* starts all four.

**The site** needs Node 22+:

```sh
cd site && npm install && npm run dev   # http://localhost:4321
```

Ports: load balancer **8090**, backends **8081–8083**, site dev server **4321**. 8080 is avoided because it's often already in use.

## Repo layout

```
lessons/             reader-facing pages: the site's content (Markdown/MDX)
site/                Astro Starlight site that publishes lessons/
.devcontainer/       Codespaces environment for the labs (Go, Claude Code, ports)
.vscode/tasks.json   one-click lab launchers
CLAUDE.md            how Claude Code should teach here
load-balancer/       working notes (README), go/ (built), rust/ (optional)
rate-limiter/        working notes (plan)
chat-system/         working notes (plan)
traffic-generator/   working notes (plan)
misc/                index of side topics
```
