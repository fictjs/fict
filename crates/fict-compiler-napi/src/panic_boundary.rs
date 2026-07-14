use std::panic::{AssertUnwindSafe, catch_unwind};

use fict_compiler::{
    CompileRequest, CompileResult, ScanRequest, ScanResult, compile, internal_error_result,
    internal_scan_error_result, scan,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PanicContained;

pub(crate) fn catch_panic<T>(operation: impl FnOnce() -> T) -> Result<T, PanicContained> {
    catch_unwind(AssertUnwindSafe(operation)).map_err(|_| PanicContained)
}

pub(crate) fn compile_safely(request: CompileRequest) -> CompileResult {
    catch_panic(|| compile(request)).unwrap_or_else(|_| internal_error_result())
}

pub(crate) fn scan_safely(request: ScanRequest) -> ScanResult {
    catch_panic(|| scan(request)).unwrap_or_else(|_| internal_scan_error_result())
}

#[cfg(test)]
mod tests {
    use super::{PanicContained, catch_panic};

    #[test]
    fn contains_panics_without_exposing_the_payload() {
        let result = catch_panic(|| panic!("sensitive panic payload"));
        assert_eq!(result, Err(PanicContained));
        assert_eq!(catch_panic(|| 42), Ok(42));
    }
}
