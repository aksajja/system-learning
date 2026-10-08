---
title: Algorithms in practice
description: The load-balancing algorithms real products offer, what they default to, why power of two choices took over, and what Nginx does and doesn't do for you.
sidebar:
  order: 3
---

The [cheat sheet](/load-balancer/cheat-sheet/#algorithms) names the algorithms. This page covers what each one is good for, what real products default to, and the configuration details that catch people out.

## The standard set

| Method | What it does | Typical use |
|---|---|---|
| **Weighted round-robin** | Take turns; a server with `weight=3` gets 3 turns per round | **The default almost everywhere.** Similar, short requests; weights handle servers of different sizes. |
| **Least connections / least requests** | Send to the server with the fewest active requests or connections | Uneven request times, long-lived connections (WebSockets) |
| **Power of two choices (P2C)** | Pick **two** servers at random, send to the less busy one | The modern refinement of least-connections (below) |
| **Hashing** (client IP, cookie, URL, user ID) | The same key always goes to the same server | Sticky sessions, caches. Use **consistent hashing** so adding a server moves only a fraction of keys. |
| **Random** | Pick any server | Simple; surprisingly fine at large scale |

Round-robin equalises the **number** of requests, not the **work**: if one request takes 10 seconds and the rest take 1 ms, the server that drew the slow one falls behind. That's what least-connections addresses.

## Why power of two choices took over

Pure least-connections has a flaw once you run **several** load balancers, which production setups always do. Each load balancer sees only its own connection counts, so they can all pick the same "least busy" server at the same moment and swamp it. The same pile-up happens when a new, empty server joins: every load balancer sends it everything.

Picking the better of **two random** servers avoids that herding, and the maths shows it spreads load almost as well as checking every server (Mitzenmacher's "power of two choices" result). Envoy's least-request balancer works this way, and Nginx offers it as `random two least_conn`.

For long-lived connections the effect is bigger: see [why power of two choices for chat](/chat-system/design/#why-the-design-looks-like-this).

## What real products offer

| Product | Default | Notable options |
|---|---|---|
| **Nginx** | Round-robin (weighted) | `least_conn`, `ip_hash`, `hash … consistent`, `random two least_conn`. `least_time` is in the commercial Nginx Plus only. |
| **HAProxy** | `roundrobin` | `leastconn`, which its docs recommend for very long sessions and not for short HTTP ones |
| **Envoy** | Round-robin | Least request (power of two choices), ring hash and Maglev (two kinds of consistent hashing), random |
| **AWS Application Load Balancer** | Round robin | Least outstanding requests, weighted random |
| **Kubernetes Services** (kube-proxy) | iptables mode: a backend chosen **at random** | IPVS mode: round-robin, weighted, least-connection and others |

## Nginx: what it does and doesn't do for you

A product takes the *code* off your hands (one config line instead of a counter), not the *decisions*. An Nginx setup matching a hand-built round-robin proxy with connection reuse and `X-Forwarded-For`:

```nginx
upstream backends {
    server localhost:8081;
    server localhost:8082;
    server localhost:8083;
    keepalive 16;                        # ① pool of reusable connections to backends
}
server {
    listen 8090;
    location / {
        proxy_pass http://backends;
        proxy_http_version 1.1;          # ① keep-alive needs HTTP/1.1
        proxy_set_header Connection "";  # ①
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # ②
    }
}
```

1. **Connection reuse to backends.** Before Nginx **1.29.7** (March 2026), Nginx spoke HTTP/1.0 to backends and kept no pool of upstream connections by default: a new connection per request, which wastes handshakes and can exhaust ephemeral ports ([port limits](/load-balancer/deep-dives/#port-limits)). The lines marked ① were required. Since 1.29.7, HTTP/1.1 and a `keepalive 32` pool are the defaults. Many deployments still run older versions, so check yours.
2. **`X-Forwarded-For` isn't added by default.** `$proxy_add_x_forwarded_for` appends the client address to any existing list. On the receiving side, the `real_ip` module applies the "trust only your own proxies, from the right" rule ([client IP behind proxies](/load-balancer/client-ip/)).
3. **Free Nginx only has passive health checks**: it marks a server down after real requests to it fail (`max_fails`, `fail_timeout`). **Active** health checks, which probe servers in the background, are part of the commercial subscription.

:::tip[Interview version]
"Weighted round-robin by default; least connections, or power of two choices with several load balancers, when request times are uneven or connections are long-lived; consistent hashing when the same key must reach the same server."
:::

## Sources
- [Mitzenmacher, Richa, Sitaraman: The Power of Two Random Choices: A Survey of Techniques and Results](https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf)
- [Envoy: Supported load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) (least request uses P2C)
- [Nginx: Using nginx as HTTP load balancer](https://nginx.org/en/docs/http/load_balancing.html) (methods, passive health checks)
- [Nginx: ngx_http_upstream_module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) (`random two`, `keepalive` default since 1.29.7)
- [Nginx: ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) (`proxy_http_version` default since 1.29.7)
- [Nginx: ngx_http_upstream_hc_module](https://nginx.org/en/docs/http/ngx_http_upstream_hc_module.html) (active health checks, commercial subscription)
- [HAProxy 2.8 configuration manual](https://docs.haproxy.org/2.8/configuration.html) (`balance` algorithms)
- [AWS: Application Load Balancer target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html) (routing algorithms)
- [Kubernetes: Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
