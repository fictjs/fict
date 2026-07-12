use fict_compiler::{CompileRequest, CompileResult, invalid_request_result};
use napi::{Error, Result, Status};
use serde_json::Value;

/// Work prepared on the JavaScript thread before async scheduling.
pub(crate) enum CompileWork {
    /// Valid owned request ready for the pure Rust pipeline.
    Request(CompileRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(CompileResult),
}

pub(crate) fn prepare_compile(value: Value) -> CompileWork {
    match serde_json::from_value(value) {
        Ok(request) => CompileWork::Request(request),
        Err(error) => CompileWork::Immediate(invalid_request_result(format!(
            "request deserialization failed: {error}"
        ))),
    }
}

pub(crate) fn serialize_result(result: CompileResult) -> Result<Value> {
    serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler result: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CompileWork, prepare_compile};

    #[test]
    fn malformed_requests_become_structured_results() {
        let work = prepare_compile(json!({ "code": 42, "filename": "module.ts" }));
        let CompileWork::Immediate(result) = work else {
            panic!("malformed request must not enter the compiler")
        };
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }
}
