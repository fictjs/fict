use fict_compiler::{
    AnalyzeResult, CompileResult, ScanResult, internal_analyze_error_result_with_context,
    internal_error_result_with_context, internal_scan_error_result_with_context,
};
use napi::{Env, Result, Task, bindgen_prelude::Object};

use crate::{
    convert::{AnalyzeWork, CompileWork, ScanWork},
    incident::{IncidentStage, PanicReport, RequestFingerprint, internal_error},
    panic_boundary::{
        analyze_safely, compile_safely, scan_safely, serialize_analyze_safely,
        serialize_compile_safely, serialize_scan_safely,
    },
};

/// Worker-pool task containing only owned Rust data and no JS callbacks/handles.
pub struct CompileTask {
    work: Option<CompileWork>,
    fingerprint: RequestFingerprint,
}

/// Worker-pool task containing only owned scan data and no JS callbacks/handles.
pub struct ScanTask {
    work: Option<ScanWork>,
    fingerprint: RequestFingerprint,
}

/// Worker-pool task containing only owned analysis data and no JS callbacks/handles.
pub struct AnalyzeTask {
    work: Option<AnalyzeWork>,
    fingerprint: RequestFingerprint,
}

impl AnalyzeTask {
    pub(crate) const fn new(work: AnalyzeWork, fingerprint: RequestFingerprint) -> Self {
        Self {
            work: Some(work),
            fingerprint,
        }
    }
}

impl Task for AnalyzeTask {
    type Output = AnalyzeResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(AnalyzeWork::Request(request)) => analyze_safely(request, &self.fingerprint),
            Some(AnalyzeWork::Immediate(result)) => result,
            None => {
                internal_analyze_error_result_with_context(worker_state_error(&self.fingerprint))
            }
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        serialize_analyze_safely(&env, output, &self.fingerprint)
    }
}

impl ScanTask {
    pub(crate) const fn new(work: ScanWork, fingerprint: RequestFingerprint) -> Self {
        Self {
            work: Some(work),
            fingerprint,
        }
    }
}

impl Task for ScanTask {
    type Output = ScanResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(ScanWork::Request(request)) => scan_safely(request, &self.fingerprint),
            Some(ScanWork::Immediate(result)) => result,
            None => internal_scan_error_result_with_context(worker_state_error(&self.fingerprint)),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        serialize_scan_safely(&env, output, &self.fingerprint)
    }
}

impl CompileTask {
    pub(crate) const fn new(work: CompileWork, fingerprint: RequestFingerprint) -> Self {
        Self {
            work: Some(work),
            fingerprint,
        }
    }
}

impl Task for CompileTask {
    type Output = CompileResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(CompileWork::Request(request)) => compile_safely(*request, &self.fingerprint),
            Some(CompileWork::Immediate(result)) => *result,
            None => internal_error_result_with_context(worker_state_error(&self.fingerprint)),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        serialize_compile_safely(&env, output, &self.fingerprint)
    }
}

fn worker_state_error(fingerprint: &RequestFingerprint) -> fict_compiler::CompilerInternalError {
    internal_error(
        IncidentStage::WorkerState,
        fingerprint,
        PanicReport {
            category: "worker-state-invariant",
            backtrace_hash: None,
        },
    )
}
