//! Differential check of a prepared step against RPC `simulateTransaction`.
//!
//! The comparison is recording pass to recording pass: the unsigned
//! transaction, with no auth entries and no resources, is what both sides
//! simulate. It is only meaningful while the step reads nothing the session
//! has changed; a step that depends on earlier session writes (or overrides)
//! cannot be simulated by the real network, and is reported as skipped.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use soroban_env_host::xdr::{
    LedgerKey, Limits, OperationBody, ReadXdr, ScVal, SorobanAuthorizationEntry, SorobanTransactionData,
    TransactionEnvelope, TransactionExt, TransactionV1Envelope, WriteXdr,
};
use soroban_sim_core::session::{show_scval, Prepared, Session};
use std::collections::BTreeSet;

use crate::report::{describe_key, DifferentialReport, FieldComparison};
use crate::rpc::RpcClient;

pub fn compare(rpc: &RpcClient, session: &Session, step: &str, prepared: &Prepared) -> DifferentialReport {
    let report = |status: &str, detail: String, fields: Vec<FieldComparison>| DifferentialReport {
        step: step.to_string(),
        status: status.to_string(),
        detail,
        fields,
    };
    let ours = &prepared.recorded;
    let fp = &ours.transaction_data.resources.footprint;
    let changed = session.ledger().changed_keys();
    let touched: Vec<&LedgerKey> = fp.read_only.iter().chain(fp.read_write.iter()).filter(|k| changed.contains(*k)).collect();
    if !touched.is_empty() {
        let names: Vec<String> = touched.iter().take(3).map(|k| describe_key(k)).collect();
        return report(
            "skipped",
            format!("reads {} entr{} the session changed ({}{})", touched.len(), if touched.len() == 1 { "y" } else { "ies" }, names.join(", "), if touched.len() > 3 { ", …" } else { "" }),
            vec![],
        );
    }
    let envelope = match unsigned(&prepared.envelope) {
        Ok(e) => e,
        Err(e) => return report("error", format!("{e:#}"), vec![]),
    };
    let result = match rpc.simulate_transaction(&envelope) {
        Ok(r) => r,
        Err(e) => return report("error", format!("{e:#}"), vec![]),
    };
    if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
        return report("differs", format!("RPC simulation failed: {err}"), vec![]);
    }
    let decode = || -> anyhow::Result<(ScVal, SorobanTransactionData, Vec<SorobanAuthorizationEntry>)> {
        let data = SorobanTransactionData::from_xdr(B64.decode(result["transactionData"].as_str().unwrap_or_default())?, Limits::none())?;
        let first = &result["results"][0];
        let value = ScVal::from_xdr(B64.decode(first["xdr"].as_str().unwrap_or_default())?, Limits::none())?;
        let auth = first["auth"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| Ok(SorobanAuthorizationEntry::from_xdr(B64.decode(a.as_str().unwrap_or_default())?, Limits::none())?))
            .collect::<anyhow::Result<_>>()?;
        Ok((value, data, auth))
    };
    let (value, data, auth) = match decode() {
        Ok(d) => d,
        Err(e) => return report("error", format!("decoding the RPC result: {e:#}"), vec![]),
    };
    let set = |v: &[LedgerKey]| v.iter().cloned().collect::<BTreeSet<_>>();
    let ours_r = &ours.transaction_data.resources;
    let rpc_r = &data.resources;
    let invocations = |a: &[SorobanAuthorizationEntry]| a.iter().map(|e| e.root_invocation.clone()).collect::<Vec<_>>();
    let fields = vec![
        field("return value", show_scval(&ours.value), show_scval(&value), ours.value == value),
        field("read-only footprint", fp.read_only.len().to_string(), rpc_r.footprint.read_only.len().to_string(), set(&fp.read_only) == set(&rpc_r.footprint.read_only)),
        field("read-write footprint", fp.read_write.len().to_string(), rpc_r.footprint.read_write.len().to_string(), set(&fp.read_write) == set(&rpc_r.footprint.read_write)),
        field("instructions", ours_r.instructions.to_string(), rpc_r.instructions.to_string(), ours_r.instructions == rpc_r.instructions),
        field("disk read bytes", ours_r.disk_read_bytes.to_string(), rpc_r.disk_read_bytes.to_string(), ours_r.disk_read_bytes == rpc_r.disk_read_bytes),
        field("write bytes", ours_r.write_bytes.to_string(), rpc_r.write_bytes.to_string(), ours_r.write_bytes == rpc_r.write_bytes),
        field("resource fee", ours.transaction_data.resource_fee.to_string(), data.resource_fee.to_string(), ours.transaction_data.resource_fee == data.resource_fee),
        field("auth invocations", ours.auth.len().to_string(), auth.len().to_string(), invocations(&ours.auth) == invocations(&auth)),
    ];
    let differing: Vec<String> = fields.iter().filter(|f| !f.equal).map(|f| format!("{} {} vs {}", f.field, f.ours, f.rpc)).collect();
    let at = result["latestLedger"].as_u64().unwrap_or(0);
    if differing.is_empty() {
        report("match", format!("RPC at ledger {at}: return value, footprint, resources, fee and auth equal"), fields)
    } else {
        report("differs", format!("RPC at ledger {at}: {}", differing.join("; ")), fields)
    }
}

fn field(name: &str, ours: String, rpc: String, equal: bool) -> FieldComparison {
    FieldComparison { field: name.into(), ours, rpc, equal }
}

/// The envelope as a client sends it to `simulateTransaction`: no signatures,
/// no Soroban data, no auth entries.
fn unsigned(envelope: &TransactionEnvelope) -> anyhow::Result<String> {
    let TransactionEnvelope::Tx(e) = envelope else { anyhow::bail!("not a v1 envelope") };
    let mut tx = e.tx.clone();
    tx.ext = TransactionExt::V0;
    let mut ops = tx.operations.to_vec();
    if let OperationBody::InvokeHostFunction(op) = &mut ops[0].body {
        op.auth = Default::default();
    }
    tx.operations = ops.try_into()?;
    Ok(B64.encode(TransactionEnvelope::Tx(TransactionV1Envelope { tx, signatures: Default::default() }).to_xdr(Limits::none())?))
}
