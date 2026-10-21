//! The facade's HTTP side: JSON-RPC 2.0 over HTTP POST (single calls and
//! batches), answered one request at a time on the thread that owns the
//! session. A session is one ordered history, so serving calls in arrival
//! order is the model, not a limitation.

use anyhow::{anyhow, Result};
use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};
use tiny_http::{Header, Method, Response, Server};

use super::Facade;

/// Requests carry envelopes with Wasm in them; the network's own limit on a
/// transaction is far below this.
const MAX_BODY: u64 = 16 << 20;

/// Listen on `host:port` (port 0 picks a free one).
pub fn bind(host: &str, port: u16) -> Result<(Server, SocketAddr)> {
    let addr = (host, port).to_socket_addrs()?.next().ok_or_else(|| anyhow!("{host}:{port} resolves to no address"))?;
    let server = Server::http(addr).map_err(|e| anyhow!("listening on {addr}: {e}"))?;
    let bound = server.server_addr().to_ip().ok_or_else(|| anyhow!("{addr} is not an IP socket"))?;
    Ok((server, bound))
}

/// Answer requests until the server is unblocked or fails.
pub fn serve(facade: &mut Facade, server: &Server) {
    for mut request in server.incoming_requests() {
        let response = match request.method() {
            Method::Post => {
                let mut body = vec![];
                match request.as_reader().take(MAX_BODY + 1).read_to_end(&mut body) {
                    Err(e) => text(400, &format!("could not read the request body: {e}")),
                    Ok(_) if body.len() as u64 > MAX_BODY => text(413, "request body too large"),
                    Ok(_) => match facade.handle_body(&body) {
                        Some(reply) => Response::from_string(reply.to_string()).with_status_code(200).with_header(header("Content-Type", "application/json")),
                        None => Response::from_string(String::new()).with_status_code(204),
                    },
                }
            }
            Method::Get | Method::Head => text(
                200,
                &format!(
                    "soroban-sim RPC facade: a fork of {} ({:?}). POST JSON-RPC 2.0 here: stellar-rpc methods plus fork_*.\n",
                    facade.network_name(),
                    facade.passphrase()
                ),
            ),
            _ => text(405, "POST JSON-RPC 2.0 requests"),
        };
        if let Err(e) = request.respond(response) {
            eprintln!("warning: answering a request: {e}");
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn text(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string()).with_status_code(status).with_header(header("Content-Type", "text/plain; charset=utf-8"))
}
