use fict_compiler::{
    AnalyzeRequest, AnalyzeResult, CompileRequest, CompileResult, ScanRequest, ScanResult,
    invalid_analyze_request_result, invalid_request_result, invalid_scan_request_result,
};
use napi::{Error, Result, Status};
use serde_json::Value;

/// Work prepared on the JavaScript thread before async scheduling.
pub(crate) enum CompileWork {
    /// Valid owned request ready for the pure Rust pipeline.
    Request(CompileRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(CompileResult),
}

/// Scan work prepared on the JavaScript thread before async scheduling.
pub(crate) enum ScanWork {
    /// Valid owned request ready for the pure Rust scanner.
    Request(ScanRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(ScanResult),
}

/// Analysis work prepared on the JavaScript thread before async scheduling.
pub(crate) enum AnalyzeWork {
    /// Valid owned request ready for the pure Rust tooling pipeline.
    Request(AnalyzeRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(AnalyzeResult),
}

pub(crate) fn prepare_compile(value: Value) -> CompileWork {
    match serde_json::from_value(value) {
        Ok(request) => CompileWork::Request(request),
        Err(error) => CompileWork::Immediate(invalid_request_result(format!(
            "request deserialization failed: {error}"
        ))),
    }
}

pub(crate) fn prepare_scan(value: Value) -> ScanWork {
    match serde_json::from_value(value) {
        Ok(request) => ScanWork::Request(request),
        Err(error) => ScanWork::Immediate(invalid_scan_request_result(format!(
            "request deserialization failed: {error}"
        ))),
    }
}

pub(crate) fn prepare_analyze(value: Value) -> AnalyzeWork {
    match serde_json::from_value(value) {
        Ok(request) => AnalyzeWork::Request(request),
        Err(error) => AnalyzeWork::Immediate(invalid_analyze_request_result(format!(
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

pub(crate) fn serialize_scan_result(result: ScanResult) -> Result<Value> {
    serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler scan result: {error}"),
        )
    })
}

pub(crate) fn serialize_analyze_result(result: AnalyzeResult) -> Result<Value> {
    serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler analysis result: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        AnalyzeWork, CompileWork, ScanWork, prepare_analyze, prepare_compile, prepare_scan,
    };

    #[test]
    fn malformed_requests_become_structured_results() {
        let work = prepare_compile(json!({ "code": 42, "filename": "module.ts" }));
        let CompileWork::Immediate(result) = work else {
            panic!("malformed request must not enter the compiler")
        };
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }

    #[test]
    fn malformed_scan_requests_become_structured_results() {
        let work = prepare_scan(json!({ "code": 42, "filename": "module.ts" }));
        let ScanWork::Immediate(result) = work else {
            panic!("malformed scan request must not enter the scanner")
        };
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }

    #[test]
    fn malformed_analyze_requests_become_structured_results() {
        let work = prepare_analyze(json!({ "code": 42, "filename": "module.ts" }));
        let AnalyzeWork::Immediate(result) = work else {
            panic!("malformed request must not enter the analyzer")
        };
        assert_eq!(result.diagnostics[0].code, "FICT-REQUEST");
    }
}
