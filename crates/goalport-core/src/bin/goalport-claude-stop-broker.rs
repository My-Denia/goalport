//! Transient Claude-only stop broker.
//!
//! Core launches this binary with a new hidden console, hands it Claude's three
//! stdio pipe handles and a private control pipe pair, and it launches the one
//! Claude child inside that console and a private job. It is not a service: it
//! registers nothing, listens on nothing, and exits with the runtime that
//! created it. All behaviour lives in `goalport_core::claude_stop_broker`.

fn main() {
    std::process::exit(goalport_core::claude_stop_broker::broker_main());
}
