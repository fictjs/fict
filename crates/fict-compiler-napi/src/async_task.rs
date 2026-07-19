use fict_compiler::{
    AnalyzeResult, CompileResult, ScanResult, internal_analyze_error_result, internal_error_result,
    internal_scan_error_result,
};
use napi::{Env, Result, Task, bindgen_prelude::Object};

use crate::{
    convert::{
        AnalyzeWork, CompileWork, ScanWork, serialize_analyze_result, serialize_result,
        serialize_scan_result,
    },
    panic_boundary::{analyze_safely, catch_panic, compile_safely, scan_safely},
};

/// Worker-pool task containing only owned Rust data and no JS callbacks/handles.
pub struct CompileTask {
    work: Option<CompileWork>,
}

/// Worker-pool task containing only owned scan data and no JS callbacks/handles.
pub struct ScanTask {
    work: Option<ScanWork>,
}

/// Worker-pool task containing only owned analysis data and no JS callbacks/handles.
pub struct AnalyzeTask {
    work: Option<AnalyzeWork>,
}

impl AnalyzeTask {
    pub(crate) const fn new(work: AnalyzeWork) -> Self {
        Self { work: Some(work) }
    }
}

impl Task for AnalyzeTask {
    type Output = AnalyzeResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(AnalyzeWork::Request(request)) => analyze_safely(request),
            Some(AnalyzeWork::Immediate(result)) => result,
            None => internal_analyze_error_result(),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        catch_panic(|| serialize_analyze_result(&env, output))
            .unwrap_or_else(|_| serialize_analyze_result(&env, internal_analyze_error_result()))
    }
}

impl ScanTask {
    pub(crate) const fn new(work: ScanWork) -> Self {
        Self { work: Some(work) }
    }
}

impl Task for ScanTask {
    type Output = ScanResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(ScanWork::Request(request)) => scan_safely(request),
            Some(ScanWork::Immediate(result)) => result,
            None => internal_scan_error_result(),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        catch_panic(|| serialize_scan_result(&env, output))
            .unwrap_or_else(|_| serialize_scan_result(&env, internal_scan_error_result()))
    }
}

impl CompileTask {
    pub(crate) const fn new(work: CompileWork) -> Self {
        Self { work: Some(work) }
    }
}

impl Task for CompileTask {
    type Output = CompileResult;
    type JsValue = Object<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(CompileWork::Request(request)) => compile_safely(request),
            Some(CompileWork::Immediate(result)) => result,
            None => internal_error_result(),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        catch_panic(|| serialize_result(&env, output))
            .unwrap_or_else(|_| serialize_result(&env, internal_error_result()))
    }
}
