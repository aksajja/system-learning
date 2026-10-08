# Load Balancer

Working notes for the load balancer experiment: build status, how to run, and what we learned. The build stops at round-robin; in interviews the load balancer is usually just a box on the diagram.

## Lessons

Reader-facing pages (shown on the site under "Load balancer"):
- `lessons/load-balancer/cheat-sheet.md`: the two-minute interview version and follow-up answers.
- `lessons/load-balancer/deep-dives.md`: scaling load balancers, several L7 proxies, failure window, ways a request can fail, port limits, WebSockets.
- `lessons/load-balancer/algorithms.md`: algorithms, product defaults, power of two choices, Nginx pitfalls (incl. the 1.29.7 keep-alive default change).
- `lessons/load-balancer/client-ip.md`: X-Forwarded-For, trust rule, Forwarded header, PROXY protocol.
- `lessons/load-balancer/lab.mdx`: hands-on steps 1–3 for a reader, with "try breaking it" exercises.
- `lessons/load-balancer/faq.md`: quiz-style follow-up questions.
- Rust port notes (reader-facing): `lessons/misc/language-choice.md`.

When a build step is done: tick it below, add a "What we learned" note, then update the lab page (and the cheat sheet or deep dives if the lesson changed).

## Layout and how to run

```
go/       Go module: backend/ (dummy backends) and proxy/ (round-robin load balancer)
rust/     Optional side project: Rust port of the proxy (done up to step 2)
```

From `load-balancer/go/`:
```sh
go run ./backend -port 8081 -name a     # one per backend: 8081, 8082, 8083
go run ./proxy                          # load balancer on :8090
```
The Rust proxy (`cargo run` in `rust/`) listens on **:8091**.

## Build log

- [x] 1. **Dummy backends**: one binary, started several times with different `-port` and `-name` flags; each replies with its name
- [x] 2. **Reverse proxy** *(Rust port ✓)*: forward every request to a single backend; pass the client IP in `X-Forwarded-For`
- [x] 3. **Round-robin**: spread requests across several backends in turn, with an atomic counter

Needed by other experiments:
- [ ] 4. **Rate limiting at the edge** *(rate limiter)*: plug the rate limiter in as middleware: per-client HTTP requests, new connections per IP, calls to the chat lookup API.
- [ ] 5. **WebSocket passthrough** *(chat step 5)*: spot the `Upgrade` header, forward the handshake, hijack the connection, copy bytes both ways with two `io.Copy` goroutines. The load balancer never reads frames.
- [ ] 6. **Routing by server ID** *(chat step 5)*: send a WebSocket to the chat server the lookup API chose (e.g. `?server=chat-7`), not by round-robin; check the signed ticket at the door.

Optional, only if a topic needs it (the cheat sheet covers them for interviews):
- [ ] Failure and health checks: kill a backend mid-traffic, measure the failure window, add active checks
  How to trigger each failure (from the deep-dives table "Ways a request can fail"):
  refused: `Ctrl+C` a backend; stuck: a "sleep forever" endpoint; reset: kill a backend during a slow request;
  connect timeout: point the load balancer at an IP where nothing exists.
- [ ] Compare with Nginx: keep-alive to upstreams, `X-Forwarded-For`, passive health checks
- [ ] Layer 4 vs layer 7, timeouts, retries
- [ ] Rust port of step 3

## What we learned

### Step 1: Dummy backends
- One program, many copies: `go run ./backend -port 8081 -name a`. Each copy replies with its name, so we can see who answered.
- `net/http` runs each request in its own goroutine, so one slow request doesn't block others.
- The `from [::1]:567xx` in the logs is the **client's** port, an *ephemeral port* the OS assigns per connection (49152–65535 on macOS). It changes with every new connection, not per server.
- A TCP connection is identified by (client IP, client port, server IP, server port).
- `curl localhost:8081 localhost:8081` reuses one connection (same client port twice): **keep-alive**. Proxies need connection reuse to stay fast and avoid running out of ephemeral ports.
- `Ctrl+C` a backend, then curl it: instant `Connection refused`, because the kernel answers when no process is listening.

### Step 2: Reverse proxy
- A reverse proxy is a **server to the client and a client to the backend**. It reads one request and builds a separate, new one for the backend.
- Go: use `http.Transport.RoundTrip`, not `http.Client` (which would follow redirects itself). Create the Transport **once**: it holds the connection pool.
- Observed: every curl reached the proxy on a new port, but the proxy reached the backend on **one reused connection**. A long-running proxy keeps its pool; a short-lived curl can't.
- Dead backend → `502 Bad Gateway` (the proxy got `connection refused`).
- The backend only sees the proxy's address, so the proxy adds **`X-Forwarded-For`** with the client IP, appending to any existing list: `client, proxy1, proxy2`.
- **Headers are client-controlled text.** `curl -H 'X-Forwarded-For: 1.2.3.4'` arrived as `1.2.3.4, ::1`. Trust only entries added by proxies you control: count from the right. Taking the first entry lets anyone fake their IP (rate limits, bans, logs).
- Not done: idle timeouts on pooled connections. The backend's idle timeout must be longer than the proxy's, or a request can land on a connection the backend is closing.

### Rust port of step 2 (`rust/src/main.rs`)
- Rust's standard library has no HTTP: we use `tokio` (async runtime), `hyper` (HTTP), `hyper-util` (client with connection pool), `clap` (flags, e.g. `cargo run -- --port 8091`).
- Go's `http.ListenAndServe` hides the accept loop; in Rust we write it: `accept()`, then `tokio::spawn` a task per connection. Same model as Go's goroutine-per-connection, made explicit.
- `Arc<str>` / `client.clone()`: shared ownership. Each connection task gets a cheap handle to the same data and pool, not a copy.
- Bodies are typed: the backend's streamed body and our own error message differ in type, so both are boxed into one `BoxBody`.
- Same observable behaviour as Go: one reused backend connection, the same `X-Forwarded-For` chain, `502` on a dead backend.

### Step 3: Round-robin
- Request *n* goes to `backends[n % len(backends)]`: 300 parallel requests split exactly 100 / 100 / 100.
- The counter is shared by all handler goroutines, so it's an `atomic.Uint64`. `next++` is read, add, write; two goroutines can interleave and pick the same backend. That's a **data race**, which in Go means no guaranteed behaviour.
- With a plain counter, the output **still looked perfect** (100/100/100), but `go run -race` reported `WARNING: DATA RACE`. Races hide in testing; the race detector catches them.
- One `http.Transport` keeps a separate connection pool per backend.
- Round-robin equalises the *number* of requests, not the *work*. Uneven request times are what least-connections addresses.
- Standard practice: weighted round-robin is the default almost everywhere; least connections or power of two choices for uneven or long-lived work; hashing for stickiness. Nginx configures this in one line but leaves the decisions (keep-alive to upstreams, `X-Forwarded-For`, health checks) to you.
