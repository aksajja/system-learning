---
title: WebSockets
description: How a WebSocket starts and what travels over it, the three different things called keep-alive, who sends pings, and why proxies need special handling.
sidebar:
  order: 2
---

Chat systems keep one long-lived connection per user so the server can push messages the moment they arrive. This page covers how that connection works, how it's kept alive, and what it means for proxies in front of it.

## How a WebSocket starts: the handshake
A WebSocket begins as an ordinary HTTP request asking to switch protocols:

```http
GET /chat HTTP/1.1
Host: chat.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

The server answers `101 Switching Protocols`. From then on the **same TCP connection** stops speaking HTTP and speaks WebSocket, in both directions, for as long as it stays open. Because the protocol changes mid-connection, proxies need to know about WebSockets ([below](#passing-websockets-through-a-proxy)).

## What travels over it: frames
Everything is sent as **frames**, each with a small header (2–14 bytes) giving its type and length:

| Frame type | Purpose |
|---|---|
| **Text / Binary** | Application data, e.g. chat messages. Almost all traffic. |
| **Close** | "I'm closing this connection", with a status code and reason |
| **Ping / Pong** | "Are you there?" / "Yes". Liveness checks, and keeping the connection from looking idle |

**Overhead is tiny.** A short message adds a 2-byte header. Frames from client to server also carry a 4-byte **mask**, a security measure against misbehaving intermediaries caching or misreading traffic. A ping is a few bytes every 20–30 seconds. Compare plain HTTP requests, which repeat hundreds of bytes of headers every time: after one handshake, each WebSocket message costs only a few bytes extra.

**There's no "from" field.** A frame doesn't say which user sent it: the connection itself is the user's identity, established at the handshake. That matters for [multiplexing](/chat-system/multiplexing/#why-plain-proxying-costs-2-sockets-per-user).

## Three kinds of keep-alive
"Keep-alive" names three unrelated mechanisms at different layers:

| Name | Layer | What it does | Reuses connections? |
|---|---|---|---|
| **HTTP keep-alive** (persistent connections) | HTTP | Keeps a TCP connection open after a response so the *next request* can reuse it | **Yes** |
| **TCP keepalive** (e.g. `curl --keepalive-time`) | OS / TCP | On an *idle* connection, the OS sends small probes to check the other side is still there | No |
| **WebSocket ping/pong** | WebSocket | Small frames inside an open WebSocket to stop idle timeouts and spot dead peers | No (there's only one connection) |

Two consequences that often confuse people:
- **Separate `curl` commands never share a connection**, whatever `--keepalive-time` says. A TCP connection belongs to the process that opened it; when `curl` exits, it closes. Reuse happens only *within* one process: `curl -v URL URL` prints `Re-using existing connection`. A long-running proxy, by contrast, keeps its pool across requests.
- **HTTP keep-alive doesn't apply to a WebSocket**: after the upgrade it's one long connection that never closes between messages, so there's nothing to reuse.

## Who sends pings, and why not TCP keepalive
The protocol defines ping and pong, and the receiver of a ping answers with a pong automatically (libraries do this for you). Something still has to **send** pings. Browser JavaScript can't, so in practice **the server pings each client** every 20–30 seconds and closes connections that don't answer.

Why not rely on TCP keepalive? The OS waits a long time before probing an idle connection: the Linux default is **2 hours**. Load balancers close idle connections much sooner (AWS's Application Load Balancer defaults to **60 seconds**), so a quiet chat would be cut long before TCP noticed anything. WebSocket pings on a 20–30 second interval keep the connection looking active and detect dead clients quickly.

## Use a library, own the policy
Go's standard library has no WebSocket server (the older `golang.org/x/net/websocket` package is discouraged), so use a maintained library such as `github.com/coder/websocket`. Hand-writing frame parsing teaches little about chat systems. The split:

| The library does (protocol mechanics) | Your code decides (policy) |
|---|---|
| The handshake (`101 Switching Protocols`) | How often to ping (e.g. every 20s) |
| Building and parsing frames | How long to wait for a pong |
| Sending a ping when asked; answering pings with pongs | What to do when no pong arrives (close, mark the user offline) |

The policy is a small loop per connection:

```go
// one per connected user, in its own goroutine
ticker := time.NewTicker(20 * time.Second)
defer ticker.Stop()
for range ticker.C {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    err := conn.Ping(ctx) // sends a ping and waits for the pong
    cancel()
    if err != nil {
        conn.Close(websocket.StatusGoingAway, "no pong") // peer is gone
        return
    }
}
```
The right interval depends on your setup, such as the load balancer's idle timeout, which is why libraries leave it to you.

## Passing WebSockets through a proxy
A plain HTTP reverse proxy thinks in request/response pairs: read a request, forward it, relay the response, done. A WebSocket breaks that model: after `101`, frames flow **both ways, whenever either side has something**, for hours. A proxy waiting for "the next request" hangs or closes the connection, and chat fails as soon as it sits behind it.

Supporting WebSockets doesn't require understanding them:
1. Notice the `Upgrade: websocket` header on a request.
2. Forward the handshake to a backend as usual.
3. After the backend's `101`, stop treating the connection as HTTP: take over the raw TCP connection (Go calls this **hijacking**, via `http.Hijacker`) and **copy bytes in both directions** until either side closes. In Go that's two goroutines, each running `io.Copy`.

No frames are parsed and no pings are sent: for that connection the L7 proxy behaves like an L4 one. Products need it enabled explicitly in places; Nginx, for example, needs the `Upgrade` and `Connection` headers passed through in its config.

## Deploys and reconnects
- A WebSocket never "finishes", so deploys must **cut** connections. If every client reconnects at once, the result is a **reconnect storm**; clients need random reconnect delays (**jitter**).
- Better: before shutting down, the server tells its clients to reconnect elsewhere, spread over a few minutes. More in [L7 proxy vs direct](/chat-system/l7-proxy-tradeoff/#what-option-b-really-loses-item-by-item) (draining row).

:::tip[Interview version]
"WebSockets start as an HTTP upgrade, then carry small frames both ways over one connection. The server pings every 20–30 seconds, because load balancers close idle connections after about a minute and TCP keepalive is far too slow. Proxies must pass the upgrade through and then just copy bytes. Deploys cut connections, so clients reconnect with jitter."
:::

## Sources
- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455) (handshake, framing, masking, ping/pong)
- [coder/websocket](https://github.com/coder/websocket) and its [Go package docs](https://pkg.go.dev/github.com/coder/websocket)
- [Go net/http package](https://pkg.go.dev/net/http) (`Hijacker`)
- [Linux kernel: IP sysctl](https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html) (`tcp_keepalive_time`, default 2 hours)
- [curl manual](https://curl.se/docs/manpage.html) (`--keepalive-time`)
- [AWS: Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html) (idle timeout, default 60 seconds)
