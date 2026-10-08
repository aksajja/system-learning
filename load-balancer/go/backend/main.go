// Command backend is a dummy server that replies with its own name.
// We run several copies on different ports so we have something to load-balance.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
)

func main() {
	port := flag.Int("port", 8081, "port to listen on")
	name := flag.String("name", "backend", "name to reply with")
	flag.Parse()

	// Prefix every log line with this backend's name, so logs from
	// several copies are easy to tell apart.
	log.SetPrefix("[" + *name + "] ")

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// RemoteAddr is the address of whoever opened the TCP connection to us.
		// X-Forwarded-For is who a proxy *says* the original client was.
		log.Printf("%s %s from %s, forwarded-for %q", r.Method, r.URL.Path, r.RemoteAddr, r.Header.Get("X-Forwarded-For"))
		fmt.Fprintf(w, "hello from %s\n", *name)
	})

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("listening on %s", addr)

	// ListenAndServe blocks forever and only returns if something goes wrong,
	// for example the port is already taken.
	log.Fatal(http.ListenAndServe(addr, nil))
}
