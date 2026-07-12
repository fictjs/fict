#![deny(unsafe_code)]

//! Minimal N-API boundary for proving native Fict compiler integration.

use fict_compiler_oxc::{ParseProbe, parse_tsx_probe};
use napi::{Env, Result, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;

const OXC_VERSION: &str = "0.139.0";

/// Native compiler build information exposed to the JavaScript loader.
#[napi(object)]
pub struct NativeCompilerInfo {
    /// Backend identifier used by compatibility and diagnostics code.
    pub backend: String,
    /// Exact OXC release compiled into this native addon.
    pub oxc_version: String,
    /// Node-API level required by this addon.
    pub node_api_version: u32,
}

/// Arena-independent parse result returned across N-API.
#[napi(object)]
pub struct ParseProbeResult {
    /// Number of top-level statements parsed from the source.
    pub statement_count: u32,
    /// Number of parser diagnostics produced for the source.
    pub diagnostic_count: u32,
}

impl From<ParseProbe> for ParseProbeResult {
    fn from(value: ParseProbe) -> Self {
        Self {
            statement_count: value.statement_count,
            diagnostic_count: value.diagnostic_count,
        }
    }
}

/// Return immutable information without touching Node or filesystem state.
#[napi]
pub fn native_compiler_info() -> NativeCompilerInfo {
    NativeCompilerInfo {
        backend: "rust".to_owned(),
        oxc_version: OXC_VERSION.to_owned(),
        node_api_version: 10,
    }
}

/// Synchronous parse probe for editor and build-tool call sites.
#[napi]
pub fn parse_tsx_probe_sync(source: String) -> ParseProbeResult {
    parse_tsx_probe(&source).into()
}

/// Worker-pool task used to prove that compilation can run off the JS thread.
pub struct ParseTsxTask {
    source: String,
}

impl Task for ParseTsxTask {
    type Output = ParseProbe;
    type JsValue = ParseProbeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(parse_tsx_probe(&self.source))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronous parse probe backed by the native worker pool.
#[napi]
pub fn parse_tsx_probe_async(source: String) -> AsyncTask<ParseTsxTask> {
    AsyncTask::new(ParseTsxTask { source })
}
