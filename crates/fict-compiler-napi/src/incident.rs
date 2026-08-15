use std::{
    io::{self, Write},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use fict_compiler::{
    AnalyzeRequest, COMPILER_CAPABILITY_PACKAGE_VERSION, CompileRequest, CompilerInternalError,
    ScanRequest, compiler_build_id, compiler_build_revision,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

static INCIDENT_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IncidentStage {
    RequestDecode,
    CompilePipeline,
    ScanPipeline,
    AnalyzePipeline,
    ResultSerialize,
    WorkerState,
    ParseProbeDecode,
    ParseProbe,
    ParseProbeSerialize,
}

impl IncidentStage {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::RequestDecode => "request-decode",
            Self::CompilePipeline => "compile-pipeline",
            Self::ScanPipeline => "scan-pipeline",
            Self::AnalyzePipeline => "analyze-pipeline",
            Self::ResultSerialize => "result-serialize",
            Self::WorkerState => "worker-state",
            Self::ParseProbeDecode => "parse-probe-decode",
            Self::ParseProbe => "parse-probe",
            Self::ParseProbeSerialize => "parse-probe-serialize",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RequestFingerprint {
    pub(crate) request: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) options: Option<String>,
}

impl RequestFingerprint {
    pub(crate) fn compile(request: &CompileRequest) -> Self {
        Self {
            request: hash_serialized(request),
            source: Some(hash_bytes(request.code.as_bytes())),
            options: hash_serialized(&(
                request.language,
                request.module_kind,
                &request.options,
                request.limits,
            )),
        }
    }

    pub(crate) fn scan(request: &ScanRequest) -> Self {
        Self {
            request: hash_serialized(request),
            source: Some(hash_bytes(request.code.as_bytes())),
            options: hash_serialized(&(request.language, request.module_kind, request.limits)),
        }
    }

    pub(crate) fn analyze(request: &AnalyzeRequest) -> Self {
        Self {
            request: hash_serialized(request),
            source: Some(hash_bytes(request.code.as_bytes())),
            options: hash_serialized(&(
                request.language,
                request.module_kind,
                &request.options,
                request.limits,
            )),
        }
    }

    pub(crate) fn source(source: &str) -> Self {
        Self {
            source: Some(hash_bytes(source.as_bytes())),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PanicReport {
    pub(crate) category: &'static str,
    pub(crate) backtrace_hash: Option<String>,
}

pub(crate) fn internal_error(
    stage: IncidentStage,
    fingerprint: &RequestFingerprint,
    panic: PanicReport,
) -> CompilerInternalError {
    let counter = INCIDENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let mut incident = Sha256::new();
    incident.update(b"fict-native-incident-v1\0");
    incident.update(compiler_build_id().as_bytes());
    incident.update(stage.as_str().as_bytes());
    incident.update(counter.to_le_bytes());
    incident.update(timestamp.to_le_bytes());
    if let Some(request) = &fingerprint.request {
        incident.update(request.as_bytes());
    }
    let incident_digest = hex_digest(incident.finalize().as_slice());

    CompilerInternalError {
        schema_version: 1,
        incident_id: format!("fict-ice-{}", &incident_digest[..24]),
        stage: stage.as_str().to_owned(),
        compiler_version: COMPILER_CAPABILITY_PACKAGE_VERSION.to_owned(),
        compiler_build_id: compiler_build_id().to_owned(),
        source_revision: compiler_build_revision().map(str::to_owned),
        native_target: env!("FICT_NATIVE_TARGET").to_owned(),
        request_fingerprint: fingerprint.request.clone(),
        source_hash: fingerprint.source.clone(),
        options_fingerprint: fingerprint.options.clone(),
        panic_category: panic.category.to_owned(),
        backtrace_hash: panic.backtrace_hash,
    }
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", hex_digest(&digest))
}

fn hash_serialized<T: Serialize>(value: &T) -> Option<String> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).ok()?;
    Some(format!("sha256:{}", hex_digest(&writer.0.finalize())))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use fict_compiler::{
        COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, RequestLimits,
        internal_analyze_error_result_with_context, internal_error_result_with_context,
        internal_scan_error_result_with_context,
    };

    use super::{IncidentStage, PanicReport, RequestFingerprint, internal_error};

    fn request(source: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: source.to_owned(),
            filename: "incident.ts".to_owned(),
            module_id: None,
            public_module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: CompilerOptions::default(),
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
            limits: RequestLimits::default(),
        }
    }

    #[test]
    fn fingerprints_never_embed_source_text() {
        let fingerprint = RequestFingerprint::compile(&request("secret source text"));
        for value in [
            fingerprint.request.as_deref(),
            fingerprint.source.as_deref(),
            fingerprint.options.as_deref(),
        ] {
            let value = value.expect("fingerprint");
            assert!(value.starts_with("sha256:"));
            assert!(!value.contains("secret"));
        }
    }

    #[test]
    fn structured_incidents_include_bounded_build_and_stage_context() {
        let context = internal_error(
            IncidentStage::CompilePipeline,
            &RequestFingerprint::compile(&request("export const value = 1")),
            PanicReport {
                category: "rust-panic-string",
                backtrace_hash: Some("sha256:backtrace".to_owned()),
            },
        );
        assert_eq!(context.schema_version, 1);
        assert!(context.incident_id.starts_with("fict-ice-"));
        assert_eq!(context.stage, "compile-pipeline");
        assert_eq!(context.panic_category, "rust-panic-string");
        assert!(context.request_fingerprint.is_some());
        assert!(!context.compiler_build_id.is_empty());
        assert!(!context.native_target.is_empty());
    }

    #[test]
    fn every_result_family_serializes_the_same_structured_ice_contract() {
        let context = internal_error(
            IncidentStage::CompilePipeline,
            &RequestFingerprint::compile(&request("private source text")),
            PanicReport {
                category: "rust-panic-string",
                backtrace_hash: Some("sha256:backtrace".to_owned()),
            },
        );

        for value in [
            serde_json::to_value(internal_error_result_with_context(context.clone()))
                .expect("compile ICE result"),
            serde_json::to_value(internal_scan_error_result_with_context(context.clone()))
                .expect("scan ICE result"),
            serde_json::to_value(internal_analyze_error_result_with_context(context))
                .expect("analyze ICE result"),
        ] {
            assert_eq!(value["internalError"]["schemaVersion"], 1);
            assert_eq!(value["internalError"]["stage"], "compile-pipeline");
            assert_eq!(value["internalError"]["panicCategory"], "rust-panic-string");
            assert!(
                value["internalError"]["incidentId"]
                    .as_str()
                    .is_some_and(|incident| incident.starts_with("fict-ice-"))
            );
            assert!(!value.to_string().contains("private source text"));
        }
    }
}
