#![deny(unsafe_code)]

//! Minimal N-API boundary for proving native Fict compiler integration.

mod async_task;
mod convert;
mod incident;
mod panic_boundary;

use async_task::{AnalyzeTask, CompileTask, ScanTask};
use convert::{
    AnalyzeWork, CompileWork, ScanWork, decode_analyze, decode_compile, decode_scan,
    serialize_parse_probe_result,
};
use fict_compiler::{
    COMPILER_CAPABILITY_MANIFEST_DIGEST, COMPILER_CAPABILITY_MANIFEST_VERSION,
    COMPILER_CAPABILITY_PACKAGE_VERSION, COMPILER_PROTOCOL_VERSION, CompilerInternalError,
    MODULE_REACTIVE_METADATA_VERSION, OXC_VERSION, ParseProbe, RequestLimits, compiler_build_id,
    compiler_build_revision, internal_analyze_error_result_with_context,
    internal_error_result_with_context, internal_scan_error_result_with_context, parse_tsx_probe,
};
use napi::{
    Env, Error, Result, Status, Task,
    bindgen_prelude::{AsyncTask, Either, Null, Object, Unknown},
};
use napi_derive::napi;
use serde::Serialize;

use incident::{IncidentStage, PanicReport, RequestFingerprint, internal_error};
use panic_boundary::{
    analyze_safely, catch_panic, compile_safely, scan_safely, serialize_analyze_safely,
    serialize_compile_safely, serialize_scan_safely,
};

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
    /// Machine-readable compiler capability manifest schema embedded in this artifact.
    pub compiler_capability_manifest_version: u32,
    /// Canonical capability manifest digest embedded in this artifact.
    pub compiler_capability_manifest_digest: String,
    /// Facade package version whose behavior this native artifact implements.
    pub compiler_capability_package_version: String,
}

/// Arena-independent parse result returned across N-API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseProbeResult {
    /// Number of top-level statements parsed from the source.
    pub statement_count: u32,
    /// Number of parser diagnostics produced for the source.
    pub diagnostic_count: u32,
    /// Sanitized context present only for a contained parser-probe panic.
    pub internal_error: Option<CompilerInternalError>,
}

impl From<ParseProbe> for ParseProbeResult {
    fn from(value: ParseProbe) -> Self {
        Self {
            statement_count: value.statement_count,
            diagnostic_count: value.diagnostic_count,
            internal_error: None,
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
        compiler_capability_manifest_version: COMPILER_CAPABILITY_MANIFEST_VERSION,
        compiler_capability_manifest_digest: COMPILER_CAPABILITY_MANIFEST_DIGEST.to_owned(),
        compiler_capability_package_version: COMPILER_CAPABILITY_PACKAGE_VERSION.to_owned(),
    }
}

/// Synchronous parse probe for editor and build-tool call sites.
#[napi(
    ts_args_type = "source: string",
    ts_return_type = "{ statementCount: number; diagnosticCount: number; internalError: object | null }"
)]
pub fn parse_tsx_probe_sync(env: Env, source: Unknown<'_>) -> Result<Object<'static>> {
    let (work, fingerprint) = prepare_parse_probe(&env, source)?;
    let result = run_parse_probe(work, &fingerprint);
    serialize_parse_probe_safely(&env, result, &fingerprint)
}

/// Worker-pool task used to prove that compilation can run off the JS thread.
pub struct ParseTsxTask {
    work: Option<ParseProbeWork>,
    fingerprint: RequestFingerprint,
}

impl Task for ParseTsxTask {
    type Output = ParseProbeResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(work) => run_parse_probe(work, &self.fingerprint),
            None => parse_probe_internal_result(internal_error(
                IncidentStage::WorkerState,
                &self.fingerprint,
                worker_state_report(),
            )),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        serialize_parse_probe_safely(&env, output, &self.fingerprint)
    }
}

/// Asynchronous parse probe backed by the native worker pool.
#[napi(
    ts_args_type = "source: string",
    ts_return_type = "Promise<{ statementCount: number; diagnosticCount: number; internalError: object | null }>"
)]
pub fn parse_tsx_probe_async(env: Env, source: Unknown<'_>) -> Result<AsyncTask<ParseTsxTask>> {
    let (work, fingerprint) = prepare_parse_probe(&env, source)?;
    Ok(AsyncTask::new(ParseTsxTask {
        work: Some(work),
        fingerprint,
    }))
}

/// Execute native compilation synchronously for editor and synchronous build APIs.
#[napi(ts_args_type = "request: object")]
pub fn transform_sync(env: Env, request: Unknown<'_>) -> Result<Object<'static>> {
    let (work, fingerprint) = decode_compile_safely(&env, request);
    let result = match work {
        CompileWork::Request(request) => compile_safely(*request, &fingerprint),
        CompileWork::Immediate(result) => *result,
    };
    serialize_compile_safely(&env, result, &fingerprint)
}

/// Schedule native compilation in the libuv worker pool after JS-value conversion.
#[napi(ts_args_type = "request: object")]
pub fn transform(env: Env, request: Unknown<'_>) -> AsyncTask<CompileTask> {
    let (work, fingerprint) = decode_compile_safely(&env, request);
    AsyncTask::new(CompileTask::new(work, fingerprint))
}

/// Scan static module requests synchronously without running compiler passes.
#[napi(ts_args_type = "request: object")]
pub fn scan_sync(env: Env, request: Unknown<'_>) -> Result<Object<'static>> {
    let (work, fingerprint) = decode_scan_safely(&env, request);
    let result = match work {
        ScanWork::Request(request) => scan_safely(request, &fingerprint),
        ScanWork::Immediate(result) => result,
    };
    serialize_scan_safely(&env, result, &fingerprint)
}

/// Scan static module requests in the libuv worker pool after JS-value conversion.
#[napi(ts_args_type = "request: object")]
pub fn scan(env: Env, request: Unknown<'_>) -> AsyncTask<ScanTask> {
    let (work, fingerprint) = decode_scan_safely(&env, request);
    AsyncTask::new(ScanTask::new(work, fingerprint))
}

/// Analyze one source file synchronously for editor and local tooling consumers.
#[napi(ts_args_type = "request: object")]
pub fn analyze_sync(env: Env, request: Unknown<'_>) -> Result<Object<'static>> {
    let (work, fingerprint) = decode_analyze_safely(&env, request);
    let result = match work {
        AnalyzeWork::Request(request) => analyze_safely(request, &fingerprint),
        AnalyzeWork::Immediate(result) => result,
    };
    serialize_analyze_safely(&env, result, &fingerprint)
}

/// Analyze one source file in the libuv worker pool after JS-value conversion.
#[napi(ts_args_type = "request: object")]
pub fn analyze(env: Env, request: Unknown<'_>) -> AsyncTask<AnalyzeTask> {
    let (work, fingerprint) = decode_analyze_safely(&env, request);
    AsyncTask::new(AnalyzeTask::new(work, fingerprint))
}

enum ParseProbeWork {
    Source(String),
    Immediate(Box<ParseProbeResult>),
}

fn prepare_parse_probe(
    env: &Env,
    source: Unknown<'_>,
) -> Result<(ParseProbeWork, RequestFingerprint)> {
    match catch_panic(|| env.from_js_value::<String, _>(source)) {
        Ok(Ok(source)) => {
            let fingerprint = RequestFingerprint::source(&source);
            let limit = RequestLimits::default().max_source_bytes;
            if source.len() as u64 > limit {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "parser probe source exceeds maxSourceBytes: observed {}, limit {limit}",
                        source.len()
                    ),
                ));
            }
            Ok((ParseProbeWork::Source(source), fingerprint))
        }
        Ok(Err(error)) => Err(error),
        Err(panic) => Ok((
            ParseProbeWork::Immediate(Box::new(parse_probe_internal_result(internal_error(
                IncidentStage::ParseProbeDecode,
                &RequestFingerprint::default(),
                panic,
            )))),
            RequestFingerprint::default(),
        )),
    }
}

fn run_parse_probe(work: ParseProbeWork, fingerprint: &RequestFingerprint) -> ParseProbeResult {
    match work {
        ParseProbeWork::Source(source) => catch_panic(|| parse_tsx_probe(&source).into())
            .unwrap_or_else(|panic| {
                parse_probe_internal_result(internal_error(
                    IncidentStage::ParseProbe,
                    fingerprint,
                    panic,
                ))
            }),
        ParseProbeWork::Immediate(result) => *result,
    }
}

fn serialize_parse_probe_safely(
    env: &Env,
    result: ParseProbeResult,
    fingerprint: &RequestFingerprint,
) -> Result<Object<'static>> {
    catch_panic(|| serialize_parse_probe_result(env, result)).unwrap_or_else(|panic| {
        serialize_parse_probe_result(
            env,
            parse_probe_internal_result(internal_error(
                IncidentStage::ParseProbeSerialize,
                fingerprint,
                panic,
            )),
        )
    })
}

fn parse_probe_internal_result(internal_error: CompilerInternalError) -> ParseProbeResult {
    ParseProbeResult {
        statement_count: 0,
        diagnostic_count: 1,
        internal_error: Some(internal_error),
    }
}

fn worker_state_report() -> PanicReport {
    PanicReport {
        category: "worker-state-invariant",
        backtrace_hash: None,
    }
}

fn decode_compile_safely(env: &Env, request: Unknown<'_>) -> (CompileWork, RequestFingerprint) {
    catch_panic(|| decode_compile(env, request)).unwrap_or_else(|panic| {
        (
            CompileWork::Immediate(Box::new(internal_error_result_with_context(
                internal_error(
                    IncidentStage::RequestDecode,
                    &RequestFingerprint::default(),
                    panic,
                ),
            ))),
            RequestFingerprint::default(),
        )
    })
}

fn decode_scan_safely(env: &Env, request: Unknown<'_>) -> (ScanWork, RequestFingerprint) {
    catch_panic(|| decode_scan(env, request)).unwrap_or_else(|panic| {
        (
            ScanWork::Immediate(internal_scan_error_result_with_context(internal_error(
                IncidentStage::RequestDecode,
                &RequestFingerprint::default(),
                panic,
            ))),
            RequestFingerprint::default(),
        )
    })
}

fn decode_analyze_safely(env: &Env, request: Unknown<'_>) -> (AnalyzeWork, RequestFingerprint) {
    catch_panic(|| decode_analyze(env, request)).unwrap_or_else(|panic| {
        (
            AnalyzeWork::Immediate(internal_analyze_error_result_with_context(internal_error(
                IncidentStage::RequestDecode,
                &RequestFingerprint::default(),
                panic,
            ))),
            RequestFingerprint::default(),
        )
    })
}
