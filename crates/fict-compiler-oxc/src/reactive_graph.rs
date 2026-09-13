//! Versioned, observational trace of reactive plans and final main-module call sites.
//! Counts are static syntax counts, never estimates of runtime allocations or cost.

use std::collections::BTreeMap;

use fict_diagnostics::SourceSpan;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OxcReactiveGraph {
    pub version: u32,
    pub scope: String,
    pub bindings: Vec<GraphBinding>,
    pub functions: Vec<GraphFunction>,
    pub operations: Vec<GraphOperation>,
    pub decisions: Vec<GraphDecision>,
    pub calls: Vec<GraphCall>,
    pub owners: Vec<GraphOwner>,
    pub counters: BTreeMap<String, u64>,
    /// Source anchors were reconciled with the reparsed final output in traversal order.
    pub source_anchors_verified: bool,
    /// No fusion is claimed merely because fewer call sites were emitted.
    pub fusion: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBinding {
    pub id: u32,
    pub name: String,
    pub declaration: Option<SourceSpan>,
    pub references: Vec<GraphReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphReference {
    pub span: SourceSpan,
    pub owner: Option<SourceSpan>,
    pub write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFunction {
    pub id: u32,
    pub kind: String,
    pub span: Option<SourceSpan>,
    pub context_helper: Option<String>,
    pub regions: Vec<u32>,
    pub slots: Vec<GraphSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSlot {
    pub id: u32,
    pub binding: Option<u32>,
    pub kind: String,
    pub storage: String,
    /// Known HIR owner for an owned or captured slot; external/aliased storage leaves it absent.
    pub owner: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOperation {
    pub id: u32,
    pub function: u32,
    pub index: u32,
    pub kind: String,
    pub slot: Option<u32>,
    pub binding: Option<u32>,
    pub helper: Option<String>,
    pub span: Option<SourceSpan>,
    pub purpose: String,
    pub cleanup: Option<GraphCleanup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCleanup {
    pub kind: String,
    /// Function id, or a slot/region id local to the operation's source function.
    pub id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDecision {
    pub binding: u32,
    pub action: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCall {
    pub id: u32,
    pub helper: String,
    /// Byte offsets in the final generated JavaScript.
    pub span: SourceSpan,
    pub source_span: Option<SourceSpan>,
    /// Lexical generated function, not an inferred runtime cleanup root.
    pub owner: Option<u32>,
    /// Exact matching source anchors only; synthetic calls may have no matching operation.
    pub operations: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOwner {
    pub id: u32,
    pub parent: Option<u32>,
    pub kind: String,
    /// Byte offsets in the final generated JavaScript.
    pub span: SourceSpan,
    pub source_span: Option<SourceSpan>,
    pub function: Option<u32>,
}
