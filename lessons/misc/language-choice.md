---
title: Choosing a language for systems work
description: Go, Python or Rust for learning how systems like load balancers and rate limiters work, why production proxies are moving to Rust, and what changes when you port a Go proxy to Rust.
sidebar:
  order: 4
---

The algorithms in system design labs (round-robin, token buckets, fan-out) are short in any language. The language matters for three other things: how well it shows **concurrency**, how well it **fits** the other pieces, and how much of your attention goes to the language instead of the system.

## For learning: Go, Python or Rust

| | Go | Python | Rust |
|---|---|---|---|
| **Concurrency model** | One goroutine per connection: maps one-to-one onto how proxies and servers work | `asyncio` or threads; the default CPython build has a global interpreter lock (GIL) | Async runtime (`tokio`); the compiler refuses to build code with data races |
| **Seeing concurrency bugs** | Real parallelism; `go run -race` **detects** data races | The GIL makes races rarer and harder to see, so bugs you'd hit in production stay hidden | Races are compile errors: very educational, but you fight the compiler before anything runs |
| **Networking in the standard library** | HTTP client and server built in | Built in, but generating heavy load from one process is hard | None: you start with `tokio` + `hyper` |
| **Learning curve** | Moderate | Easiest | Steepest: async Rust (futures, `Pin`, lifetimes across `.await`, `Arc<Mutex<…>>`) |

**Recommendation for learning:** Go. A rate limiter is basically "many requests at once update shared counters", and a load balancer is "many connections share counters, health state and pools": Go shows exactly that, and its race detector catches what you get wrong. Python reads most easily but hides the most interesting part. (CPython 3.13 added an optional free-threaded build without the GIL, but the default build still has it.) Rust is worth it when **learning Rust** is itself a goal: then a small proxy or rate limiter is a good first project.

## In production: why proxies are moving to Rust

| Proxy | Language |
|---|---|
| Nginx, HAProxy | C |
| Envoy | C++ |
| Traefik, Caddy | Go |
| Cloudflare Pingora, Linkerd's proxy | Rust |

Why Rust for high-traffic proxies:
- **No garbage collector.** Go pauses briefly to clean up memory; its pauses are now well under a millisecond, but at very large scale even rare spikes in the slowest requests matter. Rust frees memory at known points, so latency is more predictable. Discord moved a hot-path service ("Read States") from Go to Rust for this reason.
- **Memory safety without that cost.** Proxies written in C are prone to memory bugs that become security holes; Rust rules those out at compile time.
- **Control** over memory layout and system calls.

Cloudflare replaced Nginx with **Pingora**, its own Rust proxy, which it reported serving over a trillion requests a day. None of this matters at laptop scale: garbage-collector pauses only show up far beyond the traffic a lab generates.

## Porting a Go proxy to Rust: what changes

A useful exercise once a Go version works, because you already know *what* it should do and can focus on *how Rust does it*:
- **Four libraries instead of the standard library:** `tokio` (async runtime), `hyper` (HTTP), `hyper-util` (client with a connection pool), `clap` (command-line flags).
- **The accept loop is visible.** Go's `http.ListenAndServe` hides it; in Rust you write `listener.accept()` and then `tokio::spawn` a task per connection: the goroutine-per-connection model, written out.
- **Shared ownership is explicit.** Every connection task needs the backend list and the client. `Arc<str>` is a reference-counted shared string; `client.clone()` is a cheap handle onto the **same** connection pool.
- **Response bodies are typed.** The backend's streamed body and a locally made "bad gateway" message are different types, so both are boxed into one `BoxBody`.
- **Same observable behaviour:** one reused backend connection, the same `X-Forwarded-For` chain, `502` on a dead backend.

The lab's Rust port lives in [`load-balancer/rust/`](https://github.com/aksajja/system-learning/tree/main/load-balancer/rust).

## Sources
- [Cloudflare: How we built Pingora, the proxy that connects Cloudflare to the Internet](https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/)
- [Pingora on GitHub](https://github.com/cloudflare/pingora)
- [Discord: Why Discord is switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust)
- [Linkerd: Why Linkerd doesn't use Envoy](https://linkerd.io/2020/12/03/why-linkerd-doesnt-use-envoy/)
- [Go: Data Race Detector](https://go.dev/doc/articles/race_detector)
- [Python glossary: global interpreter lock](https://docs.python.org/3/glossary.html) and [PEP 703: Making the GIL optional](https://peps.python.org/pep-0703/)
- [Tokio](https://tokio.rs) and [hyper](https://hyper.rs)
