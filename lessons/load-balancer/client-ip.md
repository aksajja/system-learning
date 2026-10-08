---
title: Client IP behind proxies
description: Why servers behind a load balancer can't see the client's address, how X-Forwarded-For, Forwarded and the PROXY protocol carry it, and which parts you can trust.
sidebar:
  order: 4
---

Per-client rate limits, IP bans, fraud checks and access logs all need the **client's** address. Behind a proxy, servers don't see it. This page covers how the address travels and how much of it to trust.

## The problem
A reverse proxy is a server to the client and a client to the backend. The backend's TCP connection comes **from the proxy**, so its view of "who connected" (`RemoteAddr` in Go) is the proxy's address. In the [lab](/load-balancer/lab/) you see it directly: the backend logs the proxy's port, not the client's.

The client's identity has to travel **inside** the request or connection instead.

## At L7: X-Forwarded-For
The proxy writes the client's IP into a header before forwarding. If the header already exists (the request came through another proxy first), it **appends** rather than overwrites, building a chain:

```text
X-Forwarded-For: client, proxy1, proxy2
```

Requests seen by a backend behind one proxy:

| Request | `RemoteAddr` (TCP) | `X-Forwarded-For` |
|---|---|---|
| Straight to the backend | the client | *(empty)* |
| Through the proxy | the proxy | `203.0.113.7` (the client) |
| Through the proxy, client sent a fake header `1.2.3.4` | the proxy | `1.2.3.4, 203.0.113.7` |

## What to trust: count from the right

**Headers are text the client sent.** Anyone can put anything in them. Only the TCP connection's address is hard to fake, because replies must reach it for the connection to work.

In the chain `1.2.3.4, 203.0.113.7`:
- **`203.0.113.7`, the rightmost entry, was added by *your* proxy** from a real connection address. Trustworthy.
- **`1.2.3.4`, everything to its left, was already in the request when it arrived.** A genuine upstream proxy, or a lie.

The rule: **count from the right, skipping only proxies you control.** With one proxy, trust only the last entry. A backend that takes the **first** entry can be fooled into seeing a different IP on every request, which defeats per-IP rate limiting and bans and poisons logs. Nginx's `real_ip` module implements this rule: `set_real_ip_from` lists your trusted proxies, and `real_ip_recursive on` walks the chain from the right past them.

## The standard version: Forwarded
RFC 7239 defines a structured `Forwarded` header that carries the same information plus more (protocol, host, the proxy's own identity):

```text
Forwarded: for=203.0.113.7;proto=https, for=198.51.100.2
```

It's the standard, but `X-Forwarded-For` remains far more common in practice. The trust rule is the same.

## At L4: no headers, so the PROXY protocol
An L4 load balancer forwards TCP connections without reading HTTP, so it can't add a header. Two options:
- **Preserve the client's source IP** on the packets (some L4 load balancers do this in pass-through modes), so the backend's `RemoteAddr` is already the client.
- **The PROXY protocol** (defined by HAProxy, widely supported): the load balancer prepends one short line to the connection, before any application data, saying "the real client is X":

  ```text
  PROXY TCP4 203.0.113.7 10.0.0.5 51234 443\r\n
  ```
  The backend must be configured to expect it. It's the L4 equivalent of `X-Forwarded-For`.

:::tip[Interview version]
"The L7 load balancer adds `X-Forwarded-For` (or `Forwarded`), at L4 the PROXY protocol. It's client-controlled text, so the server trusts only entries added by our own proxies, counting from the right. The rate limiter keys on that."
:::

## Sources
- [MDN: X-Forwarded-For](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For) (including the security notes on choosing the right entry)
- [RFC 7239: Forwarded HTTP Extension](https://www.rfc-editor.org/rfc/rfc7239)
- [HAProxy: The PROXY protocol specification](https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt)
- [Nginx: ngx_http_realip_module](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
