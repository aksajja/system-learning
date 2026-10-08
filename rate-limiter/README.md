# Rate Limiter

Classic interview question: "Design a rate limiter." Design it on paper first, then build the deep-dive parts in Go.

These are working notes.

## Lessons

Reader-facing pages (shown on the site under "Rate limiter"):
- `lessons/rate-limiter/where-it-lives.md`: placement, what each layer can see, keying on identity, shared counters, 429 responses.
- `lessons/rate-limiter/faq.md`: quiz-style follow-up questions.

Still to write when Part 1 and the build are done: the finished interview design, algorithms, a lab page and a cheat sheet.

## Part 1: Interview design (on paper, in this README)

Work through these as you would out loud in an interview:
- [ ] **Requirements**: limit by what (user ID, IP, API key)? Example rule: 100 requests/minute per user. Non-functional: adds very little latency, works across many servers, what happens if the limiter itself fails?
- [ ] **Where it lives**: in the client, in each server (middleware), or in front of servers (API gateway / load balancer). Trade-offs of each.
- [ ] **API / behaviour**: reject with `429 Too Many Requests`, plus headers like `Retry-After` and `X-RateLimit-Remaining`.
- [ ] **Algorithms**: fixed window, sliding window log, sliding window counter, token bucket, leaky bucket. Accuracy vs memory vs burst behaviour.
- [ ] **Storage**: counters per key, shared by all servers (usually Redis), with expiry.
- [ ] **Deep dives**: race conditions on shared counters, keeping it fast, Redis failure (fail open vs fail closed), multiple regions, identifying the client behind a proxy (`X-Forwarded-For`).

## Part 2: Build the deep dives (Go)

- [ ] 1. **Fixed window, in memory**: middleware in front of a handler. Observe the **boundary burst**: up to 2× the limit across a window edge.
- [ ] 2. **Token bucket, in memory**: allows short bursts, enforces a steady rate. Compare with fixed window under the same traffic.
- [ ] 3. **Two servers behind the load balancer**: each keeps its own counters, so the real limit becomes limit × servers. Discover the problem.
- [ ] 4. **Shared limiter in Redis**: first the naive read-then-write (a race between servers), then an atomic version (`INCR` + `EXPIRE`, or a Lua script).
- [ ] 5. **Redis goes down**: decide and test fail open vs fail closed.
- [ ] 6. **Interview cheat sheet**: the short version plus follow-up answers.

**Nice to have: real-world follow-ups**
- [ ] Run **two copies of the load balancer** with the in-memory limiter: N load balancers allow N × the limit, the same leak as step 3, seen from the edge. Then point both at the Redis limiter. (Real systems run fleets of L7 proxies; see the load balancer cheat sheet's follow-ups.)

**Where our limiter gets used:**
- In the load balancer (`../load-balancer`, build step 4): per-client HTTP requests, new connections per IP, calls to the chat lookup API.
- In the chat server (`../chat-system`, step 8): messages per user. Once a WebSocket is open, the load balancer only passes bytes and can't see individual messages, so message limits must live in the server that reads them.

So the limiter should be a small reusable Go package, not tied to one server.

Related: limiting by client IP behind a proxy means trusting `X-Forwarded-For` correctly (see `../load-balancer/README.md`). Testing uses `../traffic-generator` (fixed request rate, many simulated clients).

## Notes

## What we learned

