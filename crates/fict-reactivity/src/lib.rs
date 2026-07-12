#![forbid(unsafe_code)]

//! CFG, SSA, reactivity, region, and optimizer passes over Fict-owned HIR.

mod cfg;

pub use cfg::{CfgAnalysis, analyze_cfg};
