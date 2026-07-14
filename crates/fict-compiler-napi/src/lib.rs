#![deny(unsafe_code)]

//! Minimal N-API boundary for proving native Fict compiler integration.

mod async_task;
mod convert;
mod panic_boundary;

use async_task::{AnalyzeTask, CompileTask, ScanTask};
use convert::{
    AnalyzeWork, CompileWork, ScanWork, prepare_analyze, prepare_compile, prepare_scan,
    serialize_analyze_result, serialize_result, serialize_scan_result,
};
use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, MODULE_REACTIVE_METADATA_VERSION, OXC_VERSION, ParseProbe,
    compiler_build_id, compiler_build_revision, parse_tsx_probe,
};
use napi::{
    Env, Result, Task,
    bindgen_prelude::{AsyncTask, Either, Null},
};
use napi_derive::napi;
use panic_boundary::{analyze_safely, catch_panic, compile_safely, scan_safely};
use serde_json::Value;

/// Native compiler build information exposed to the JavaScript loader.
#[napi(object)]
pub struct NativeCompilerInfo {
    /// Backend identifier used by compatibility and diagnostics code.
    pub backend: String,
    /// Exact Rust target triple used to build this addon.
    pub native_target: String,
    /// Exact OXC release compiled into this native addon.
    pub oxc_version: String,
    /// Node-API level required by this addon.
    pub node_api_version: u32,
    /// Immutable cache/rollback identity for this native artifact.
    pub compiler_build_id: String,
    /// Exact Git source revision embedded by controlled builds, or null for local builds.
    pub compiler_build_revision: Either<String, Null>,
    /// Request/result protocol accepted by this artifact.
    pub compiler_protocol_version: u32,
    /// Module metadata schema accepted by this artifact.
    pub metadata_schema_version: u32,
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
        native_target: env!("FICT_NATIVE_TARGET").to_owned(),
        oxc_version: OXC_VERSION.to_owned(),
        node_api_version: 10,
        compiler_build_id: compiler_build_id().to_owned(),
        compiler_build_revision: match compiler_build_revision() {
            Some(revision) => Either::A(revision.to_owned()),
            None => Either::B(Null),
        },
        compiler_protocol_version: COMPILER_PROTOCOL_VERSION,
        metadata_schema_version: MODULE_REACTIVE_METADATA_VERSION,
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

/// Execute native compilation synchronously for editor and synchronous build APIs.
#[napi]
pub fn transform_sync(request: Value) -> Result<Value> {
    let work = catch_panic(|| prepare_compile(request))
        .unwrap_or_else(|_| CompileWork::Immediate(fict_compiler::internal_error_result()));
    let result = match work {
        CompileWork::Request(request) => compile_safely(request),
        CompileWork::Immediate(result) => result,
    };
    catch_panic(|| serialize_result(result))
        .unwrap_or_else(|_| serialize_result(fict_compiler::internal_error_result()))
}

/// Schedule native compilation in the libuv worker pool after JS-value conversion.
#[napi]
pub fn transform(request: Value) -> AsyncTask<CompileTask> {
    let work = catch_panic(|| prepare_compile(request))
        .unwrap_or_else(|_| CompileWork::Immediate(fict_compiler::internal_error_result()));
    AsyncTask::new(CompileTask::new(work))
}

/// Scan static module requests synchronously without running compiler passes.
#[napi]
pub fn scan_sync(request: Value) -> Result<Value> {
    let work = catch_panic(|| prepare_scan(request))
        .unwrap_or_else(|_| ScanWork::Immediate(fict_compiler::internal_scan_error_result()));
    let result = match work {
        ScanWork::Request(request) => scan_safely(request),
        ScanWork::Immediate(result) => result,
    };
    catch_panic(|| serialize_scan_result(result))
        .unwrap_or_else(|_| serialize_scan_result(fict_compiler::internal_scan_error_result()))
}

/// Scan static module requests in the libuv worker pool after JS-value conversion.
#[napi]
pub fn scan(request: Value) -> AsyncTask<ScanTask> {
    let work = catch_panic(|| prepare_scan(request))
        .unwrap_or_else(|_| ScanWork::Immediate(fict_compiler::internal_scan_error_result()));
    AsyncTask::new(ScanTask::new(work))
}

/// Analyze one source file synchronously for editor and local tooling consumers.
#[napi]
pub fn analyze_sync(request: Value) -> Result<Value> {
    let work = catch_panic(|| prepare_analyze(request))
        .unwrap_or_else(|_| AnalyzeWork::Immediate(fict_compiler::internal_analyze_error_result()));
    let result = match work {
        AnalyzeWork::Request(request) => analyze_safely(request),
        AnalyzeWork::Immediate(result) => result,
    };
    catch_panic(|| serialize_analyze_result(result)).unwrap_or_else(|_| {
        serialize_analyze_result(fict_compiler::internal_analyze_error_result())
    })
}

/// Analyze one source file in the libuv worker pool after JS-value conversion.
#[napi]
pub fn analyze(request: Value) -> AsyncTask<AnalyzeTask> {
    let work = catch_panic(|| prepare_analyze(request))
        .unwrap_or_else(|_| AnalyzeWork::Immediate(fict_compiler::internal_analyze_error_result()));
    AsyncTask::new(AnalyzeTask::new(work))
}
