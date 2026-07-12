use fict_compiler::{CompileResult, internal_error_result};
use napi::{Env, Result, Task, bindgen_prelude::Unknown};

use crate::{
    convert::{CompileWork, serialize_result},
    panic_boundary::{catch_panic, compile_safely},
};

/// Worker-pool task containing only owned Rust data and no JS callbacks/handles.
pub struct CompileTask {
    work: Option<CompileWork>,
}

impl CompileTask {
    pub(crate) const fn new(work: CompileWork) -> Self {
        Self { work: Some(work) }
    }
}

impl Task for CompileTask {
    type Output = CompileResult;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = match self.work.take() {
            Some(CompileWork::Request(request)) => compile_safely(request),
            Some(CompileWork::Immediate(result)) => result,
            None => internal_error_result(),
        };
        Ok(result)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let value = catch_panic(|| serialize_result(output))
            .unwrap_or_else(|_| serialize_result(internal_error_result()))?;
        env.to_js_value(&value)
    }
}
