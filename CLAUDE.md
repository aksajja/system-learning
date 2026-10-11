# System Learning Sandbox

This folder is for **system design interview preparation**: understanding how systems work by designing them the way an interview asks, then building the parts interviewers probe. Each experiment lives in its own subfolder with a README that holds its plan and notes.

## Lessons vs READMEs (two audiences, no duplication)
- `lessons/`: **reader-facing** pages, published as a Starlight site (`site/`, see `site/README.md`). Written for someone studying system design: no first-person build log, no machine-specific details, each topic in exactly one place. Frontmatter: `title`, `description`, `sidebar.order`. Link between lessons with site paths (`/chat-system/design/`); link to code on GitHub. Lab pages are `.mdx` and use `OpenLab` from `site/src/components/mdx.ts`.
- **Organising lesson content:** a deep-dive answer that fits a page's natural flow goes into that page (or a new topic page); one that doesn't goes into the section's `faq.md` (last in its sidebar group). FAQ entries are quiz-style: `<details><summary>Question?</summary>` with a short answer, a `**More:**` link to the full section, and `**Sources:**` when the answer cites external facts.
- **References:** every page that states external facts ends with `## Sources` (a bulleted list of `[Title](url)`). Prefer primary sources (RFCs, official docs, company engineering blogs); check each link opens and the claim matches before citing; mark anything unconfirmed as such.
- `<experiment>/README.md`: **the builder's working notes**: checklists, build log, how to run, "What we learned", open questions, and a "Lessons" list pointing to the matching pages. Never copy lesson text into a README.
- `.devcontainer/` and `.vscode/tasks.json`: the Codespaces lab environment behind the site's "Open this lab" button. When a lab needs a new service (e.g. Redis) or port, add it there.

## How each experiment is structured
1. **Design it on paper, interview-style** (working draft in the README, finished version in `lessons/`): requirements (functional and non-functional), rough estimates (traffic, storage), API, high-level diagram, data model, then deep dives and trade-offs. Practise it as the learner would say it in an interview.
2. **Build only the deep-dive parts**: the pieces interviewers push on, where running code makes the trade-offs concrete. Not the whole system.
3. **Finish with an interview cheat sheet** in `lessons/<experiment>/`: the short version to say out loud, plus answers to common follow-up questions. `lessons/load-balancer/cheat-sheet.md` is the model, and `lessons/load-balancer/lab.mdx` is the model lab page.

## Language
- Go, standard library first. No frameworks unless the lesson is about that framework. Use a library where the standard library has nothing and the protocol isn't what's being studied (e.g. `github.com/coder/websocket`).
- Assume the learner has some Go experience unless they say otherwise: explain non-obvious idioms (goroutines, channels, `context`, `sync`, `net/http` internals) the first time they appear; skip basic syntax.
- Rust: optional side project only (`load-balancer/rust/`). It teaches Rust, not system design.

## How we work
- One concept per step. Keep each step small enough to run and observe.
- Explain the *why* (the problem this step solves) before writing code.
- Every step ends with something the learner runs and observes: curl, logs, killing a process, traffic-generator output.
- Build the mechanism being studied ourselves rather than importing it.
- After each step, stop and check in before continuing. Offer an optional "try breaking it" exercise.
- When the learner asks a question, answer it. Don't start building until they say so.
- When a step is done, tick it off in the experiment's README and add a short "what we learned" note. Then update the reader-facing lab page in `lessons/` (and the cheat sheet or deep dives if the lesson changed), and check `cd site && npm run build` still passes.
- Tie things back to interviews: which follow-up questions this answers.

## Learners
- Anyone can study here in their own Claude session, usually a Codespace opened from a lab page. The repo owner (`aksajja`) maintains `lessons/` and the experiment READMEs; everyone else sends changes as pull requests.
- Each learner has a personal summary at `learners/<github-username>/notes.md`: what they learned, in their words, and what they're still unsure about. It isn't published on the site. A learner who isn't the owner records build progress there, not in the experiment README.
- `/wrap-up` (`.claude/skills/wrap-up/`) ends a session: it updates the learner's notes, has the `lesson-editor` agent draft lesson fixes in the background, and opens a draft PR with whatever the learner chooses to send. Nothing leaves the session without the learner's yes.

## Ports
- The Go load balancer uses **8090**, the Rust one **8091**; backends use 8081–8083. The distributed cache uses **8100** (fake DB) and **8101–8104** (cache nodes). (8080 is avoided because it's often taken by something else, e.g. a Docker container.) If a port is busy, check with `lsof -i :<port>` and pick another.

## Experiments
- `load-balancer/`: steps 1–3 built (backends, reverse proxy, round-robin). Lessons: cheat sheet, deep dives, algorithms, client IP, lab, FAQ. Steps 4–6 (edge rate limiting, WebSocket passthrough, routing by server ID) get built when the rate limiter and chat experiments need them; the rest is optional.
- `rate-limiter/`: next. Classic interview question. Lessons so far: "Where rate limiting lives" and a FAQ; the interview design, algorithms, lab and cheat sheet come with the build.
- `chat-system/`: classic interview question (WhatsApp/Messenger-style). Plan in its README; design lessons in `lessons/chat-system/`; nothing built yet.
- `distributed-cache/`: classic interview question (Memcached/Redis-style). Part 1 runs as a mock interview (the learner drives, Claude interviews); notes in its README; design lessons in `lessons/distributed-cache/`; nothing built yet.
- `traffic-generator/`: shared tooling to drive load against any experiment.
- `lessons/interview-skills/`: generic interview skills used by every experiment (estimates so far). Lessons only, no experiment folder.
- `misc/`: nice-to-know side topics, nothing built. When one comes up that's useful but rarely an interview focus, write it as a new page in `lessons/misc/` and add a row to `misc/README.md`.
