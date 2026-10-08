// Command proxy is a load-balancing reverse proxy: it accepts requests from
// clients, forwards each one to a backend chosen in turn (round-robin), and
// relays the response back.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
)

func main() {
	// Not 8080: it is often already taken (e.g. by a Docker container).
	port := flag.Int("port", 8090, "port to listen on")
	backendList := flag.String("backends", "http://localhost:8081,http://localhost:8082,http://localhost:8083",
		"comma-separated backends to spread requests across")
	flag.Parse()

	backends := strings.Split(*backendList, ",")

	// Counts requests so far; request n goes to backends[n % len(backends)].
	// Handlers run concurrently in many goroutines, so a plain int would be a
	// data race: "next++" is read, add, write, and two goroutines can interleave.
	// atomic.Uint64 does the increment as one indivisible step.
	var next atomic.Uint64

	log.SetPrefix("[proxy] ")

	// A Transport sends one request and returns one response, nothing more
	// (unlike http.Client, it won't follow redirects on the client's behalf).
	// It also keeps a pool of open connections per backend and reuses them.
	// DisableCompression stops it from quietly asking the backend for gzip.
	transport := &http.Transport{DisableCompression: true}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 0. Pick this request's backend: take turns, wrapping around at the end.
		//    Add returns the new value, so subtract 1 to start at backends[0].
		backend := backends[(next.Add(1)-1)%uint64(len(backends))]

		// 1. Build the outgoing request: same method, path, headers and body,
		//    but sent to the backend instead of to us.
		outReq, err := http.NewRequestWithContext(r.Context(), r.Method, backend+r.URL.RequestURI(), r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		outReq.Header = r.Header.Clone()
		outReq.ContentLength = r.ContentLength

		// Tell the backend who the real client is, since the connection it sees
		// comes from us. If the request already passed through other proxies,
		// append to their list: "client, proxy1, proxy2".
		clientIP, _, _ := net.SplitHostPort(r.RemoteAddr)
		if prior := outReq.Header.Values("X-Forwarded-For"); len(prior) > 0 {
			clientIP = strings.Join(prior, ", ") + ", " + clientIP
		}
		outReq.Header.Set("X-Forwarded-For", clientIP)

		// 2. Send it to the backend and wait for the response.
		resp, err := transport.RoundTrip(outReq)
		if err != nil {
			log.Printf("%s %s from %s -> %s error: %v", r.Method, r.URL.Path, r.RemoteAddr, backend, err)
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// 3. Relay the response: headers first, then status code, then body.
		for name, values := range resp.Header {
			for _, v := range values {
				w.Header().Add(name, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)

		log.Printf("%s %s from %s -> %s (%d)", r.Method, r.URL.Path, r.RemoteAddr, backend, resp.StatusCode)
	})

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("listening on %s, balancing across %s", addr, strings.Join(backends, ", "))
	log.Fatal(http.ListenAndServe(addr, nil))
}
