use std::{
    backtrace::{Backtrace, BacktraceStatus},
    cell::{Cell, RefCell},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Once,
};

use fict_compiler::{
    AnalyzeRequest, AnalyzeResult, CompileRequest, CompileResult, ScanRequest, ScanResult, analyze,
    compile, internal_analyze_error_result_with_context, internal_error_result_with_context,
    internal_scan_error_result_with_context, scan,
};
use napi::{Env, Result, bindgen_prelude::Object};

use crate::{
    convert::{serialize_analyze_result, serialize_result, serialize_scan_result},
    incident::{IncidentStage, PanicReport, RequestFingerprint, hash_bytes, internal_error},
};

thread_local! {
    static CONTAINMENT_DEPTH: Cell<u32> = const { Cell::new(0) };
    static CAPTURED_PANIC: RefCell<Option<PanicReport>> = const { RefCell::new(None) };
}

static INSTALL_PANIC_HOOK: Once = Once::new();

pub(crate) fn catch_panic<T>(operation: impl FnOnce() -> T) -> std::result::Result<T, PanicReport> {
    install_containment_hook();
    let outermost = CONTAINMENT_DEPTH.with(|depth| {
        let outermost = depth.get() == 0;
        depth.set(depth.get().saturating_add(1));
        outermost
    });
    if outermost {
        CAPTURED_PANIC.with(|captured| *captured.borrow_mut() = None);
    }
    let result = catch_unwind(AssertUnwindSafe(operation));
    CONTAINMENT_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    result.map_err(|payload| {
        CAPTURED_PANIC
            .with(|captured| captured.borrow_mut().take())
            .unwrap_or_else(|| PanicReport {
                category: panic_category(payload.as_ref()),
                backtrace_hash: None,
            })
    })
}

pub(crate) fn compile_safely(
    request: CompileRequest,
    fingerprint: &RequestFingerprint,
) -> CompileResult {
    catch_panic(|| compile(request)).unwrap_or_else(|panic| {
        internal_error_result_with_context(internal_error(
            IncidentStage::CompilePipeline,
            fingerprint,
            panic,
        ))
    })
}

pub(crate) fn scan_safely(request: ScanRequest, fingerprint: &RequestFingerprint) -> ScanResult {
    catch_panic(|| scan(request)).unwrap_or_else(|panic| {
        internal_scan_error_result_with_context(internal_error(
            IncidentStage::ScanPipeline,
            fingerprint,
            panic,
        ))
    })
}

pub(crate) fn analyze_safely(
    request: AnalyzeRequest,
    fingerprint: &RequestFingerprint,
) -> AnalyzeResult {
    catch_panic(|| analyze(request)).unwrap_or_else(|panic| {
        internal_analyze_error_result_with_context(internal_error(
            IncidentStage::AnalyzePipeline,
            fingerprint,
            panic,
        ))
    })
}

pub(crate) fn serialize_compile_safely(
    env: &Env,
    result: CompileResult,
    fingerprint: &RequestFingerprint,
) -> Result<Object<'static>> {
    catch_panic(|| serialize_result(env, result)).unwrap_or_else(|panic| {
        serialize_result(
            env,
            internal_error_result_with_context(internal_error(
                IncidentStage::ResultSerialize,
                fingerprint,
                panic,
            )),
        )
    })
}

pub(crate) fn serialize_scan_safely(
    env: &Env,
    result: ScanResult,
    fingerprint: &RequestFingerprint,
) -> Result<Object<'static>> {
    catch_panic(|| serialize_scan_result(env, result)).unwrap_or_else(|panic| {
        serialize_scan_result(
            env,
            internal_scan_error_result_with_context(internal_error(
                IncidentStage::ResultSerialize,
                fingerprint,
                panic,
            )),
        )
    })
}

pub(crate) fn serialize_analyze_safely(
    env: &Env,
    result: AnalyzeResult,
    fingerprint: &RequestFingerprint,
) -> Result<Object<'static>> {
    catch_panic(|| serialize_analyze_result(env, result)).unwrap_or_else(|panic| {
        serialize_analyze_result(
            env,
            internal_analyze_error_result_with_context(internal_error(
                IncidentStage::ResultSerialize,
                fingerprint,
                panic,
            )),
        )
    })
}

fn install_containment_hook() {
    INSTALL_PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let contained = CONTAINMENT_DEPTH.with(|depth| depth.get() > 0);
            if !contained {
                previous(info);
                return;
            }
            let backtrace = Backtrace::capture();
            let backtrace_hash = (backtrace.status() == BacktraceStatus::Captured)
                .then(|| hash_bytes(backtrace.to_string().as_bytes()));
            CAPTURED_PANIC.with(|captured| {
                *captured.borrow_mut() = Some(PanicReport {
                    category: panic_category(info.payload()),
                    backtrace_hash,
                });
            });
        }));
    });
}

fn panic_category(payload: &(dyn std::any::Any + Send)) -> &'static str {
    if payload.is::<&'static str>() || payload.is::<String>() {
        "rust-panic-string"
    } else {
        "rust-panic-non-string"
    }
}

#[cfg(test)]
mod tests {
    use super::catch_panic;

    #[test]
    fn contains_panics_without_exposing_the_payload() {
        let result = catch_panic(|| panic!("sensitive panic payload"));
        let report = result.expect_err("panic must be contained");
        assert_eq!(report.category, "rust-panic-string");
        assert!(
            report
                .backtrace_hash
                .as_deref()
                .is_none_or(|hash| hash.starts_with("sha256:"))
        );
        assert!(!format!("{report:?}").contains("sensitive panic payload"));
        assert_eq!(catch_panic(|| 42), Ok(42));
    }
}
