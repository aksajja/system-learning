//! A reverse proxy: accepts requests from clients, forwards each one to a
//! single backend, and relays the response back. Rust port of ../go/proxy.

use std::{convert::Infallible, net::SocketAddr, sync::Arc};

use bytes::Bytes;
use clap::Parser;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{
    Request, Response, StatusCode, Uri,
    body::Incoming,
    header::{self, HeaderValue},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::{TokioExecutor, TokioIo},
};
use tokio::net::TcpListener;

#[derive(Parser)]
struct Args {
    /// Port to listen on
    #[arg(long, default_value_t = 8091)]
    port: u16,
    /// Backend to forward requests to
    #[arg(long, default_value = "http://localhost:8081")]
    backend: String,
}

/// The body type we send back to clients: either the backend's streamed body
/// or a small error message we make ourselves. Boxing lets both share one type.
type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// Like Go's http.Transport: sends requests and keeps a pool of open
/// connections to the backend for reuse.
type BackendClient = Client<HttpConnector, Incoming>;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();

    // Arc = shared, reference-counted ownership: every connection task gets a
    // cheap handle to the same string instead of its own copy.
    let backend: Arc<str> = args.backend.into();
    let client: BackendClient = Client::builder(TokioExecutor::new()).build_http();

    let listener = TcpListener::bind(SocketAddr::from(([0; 16], args.port))).await?;
    eprintln!("[proxy-rs] listening on :{}, forwarding to {backend}", args.port);

    // Go's http.ListenAndServe hides this loop. Here it is spelled out:
    // accept a connection, then spawn a task (Rust's goroutine) to serve it.
    loop {
        let (stream, client_addr) = listener.accept().await?;
        let client = client.clone(); // cheap: clones share one connection pool
        let backend = backend.clone();

        tokio::spawn(async move {
            let service = service_fn(move |req| {
                forward(req, client.clone(), backend.clone(), client_addr)
            });
            if let Err(err) = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                eprintln!("[proxy-rs] connection from {client_addr} failed: {err}");
            }
        });
    }
}

async fn forward(
    req: Request<Incoming>,
    client: BackendClient,
    backend: Arc<str>,
    client_addr: SocketAddr,
) -> Result<Response<ProxyBody>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // 1. Build the outgoing request: same method, path, headers and body,
    //    but sent to the backend instead of to us.
    let (mut parts, body) = req.into_parts();
    let path_and_query = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    parts.uri = match format!("{backend}{path_and_query}").parse::<Uri>() {
        Ok(uri) => uri,
        Err(err) => return Ok(error_response(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
    };
    // Drop the client's Host header ("localhost:8091"); the client library
    // fills in the backend's, like Go's http.NewRequest does.
    parts.headers.remove(header::HOST);

    // Tell the backend who the real client is, appending to any existing list.
    let mut forwarded_for: Vec<String> = parts
        .headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok().map(String::from))
        .collect();
    forwarded_for.push(client_addr.ip().to_string());
    if let Ok(value) = HeaderValue::from_str(&forwarded_for.join(", ")) {
        parts.headers.insert("x-forwarded-for", value);
    }

    // 2. Send it to the backend and wait for the response.
    match client.request(Request::from_parts(parts, body)).await {
        Ok(resp) => {
            eprintln!("[proxy-rs] {method} {path} from {client_addr} -> {backend} ({})", resp.status());
            // 3. Relay the response. The body is streamed through, not buffered.
            Ok(resp.map(|body| body.boxed()))
        }
        Err(err) => {
            eprintln!("[proxy-rs] {method} {path} from {client_addr} -> backend error: {err:?}");
            Ok(error_response(StatusCode::BAD_GATEWAY, "bad gateway\n".into()))
        }
    }
}

fn error_response(status: StatusCode, message: String) -> Response<ProxyBody> {
    // Full<Bytes> can never fail, but ProxyBody's error type is hyper::Error,
    // so map the "impossible" error type across.
    let body = Full::new(Bytes::from(message)).map_err(|never| match never {}).boxed();
    let mut resp = Response::new(body);
    *resp.status_mut() = status;
    resp
}
