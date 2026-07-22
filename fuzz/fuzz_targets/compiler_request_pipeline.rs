#![no_main]

use std::collections::BTreeSet;

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompileResult, CompilerOptions,
    CompilerPreviewOptions, ModuleKind, OptimizeLevel, RawSourceMap, ScanRequest, SourceLanguage,
    compile, scan,
};
use fict_diagnostics::{DiagnosticSeverity, GuaranteeClass};
use fict_metadata::{
    HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
    ResolvedMetadataInput,
};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

const MAX_INPUT_BYTES: usize = 32 * 1024;

fuzz_target!(|data: &[u8]| {
    if data.is_empty() || data.len() > MAX_INPUT_BYTES {
        return;
    }
    let Ok(source) = std::str::from_utf8(data) else {
        return;
    };
    let controls = control_bits(data);
    let mut request = request_for(source, controls);
    let primary_strict = enabled(controls, 42);
    request.options.strict_guarantee = primary_strict;
    let request = napi_request_round_trip(&request);

    let first = compile(request.clone());
    let second = compile(request.clone());
    assert_eq!(
        deterministic_result(first.clone()),
        deterministic_result(second),
        "the public compile pipeline must be deterministic"
    );
    validate_result(&request, &first);

    let mut opposite_request = request.clone();
    opposite_request.options.strict_guarantee = !primary_strict;
    let opposite = compile(opposite_request.clone());
    validate_result(&opposite_request, &opposite);

    let (fallback, strict) = if primary_strict {
        (&opposite, &first)
    } else {
        (&first, &opposite)
    };
    validate_strict_fallback_policy(fallback, strict);
});

fn control_bits(data: &[u8]) -> u64 {
    data.iter()
        .enumerate()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, (index, byte)| {
            hash.rotate_left((index % 63 + 1) as u32)
                ^ u64::from(*byte).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

const fn enabled(controls: u64, bit: u32) -> bool {
    controls & (1_u64 << bit) != 0
}

fn request_for(source: &str, controls: u64) -> CompileRequest {
    let language = match controls & 0b11 {
        0 => SourceLanguage::JavaScript,
        1 => SourceLanguage::TypeScript,
        2 => SourceLanguage::JavaScriptJsx,
        _ => SourceLanguage::TypeScriptJsx,
    };
    let module_kind = match (controls >> 2) & 0b11 {
        0 => ModuleKind::Module,
        1 => ModuleKind::Script,
        2 => ModuleKind::CommonJs,
        _ => ModuleKind::Unambiguous,
    };
    let extension = match language {
        SourceLanguage::JavaScript => "js",
        SourceLanguage::JavaScriptJsx => "jsx",
        SourceLanguage::TypeScript => "ts",
        SourceLanguage::TypeScriptJsx => "tsx",
    };
    let filename = format!("/fuzz/compiler-request.{extension}");
    let preview = enabled(controls, 26).then(|| CompilerPreviewOptions {
        resumable: enabled(controls, 27),
        auto_extract_handlers: enabled(controls, 28),
        auto_extract_threshold: u32::try_from((controls >> 29) & 0b111)
            .expect("three bits fit in u32")
            + 1,
    });
    let mut options = CompilerOptions {
        dev: enabled(controls, 4),
        sourcemap: enabled(controls, 5),
        explain: enabled(controls, 6),
        lazy_conditional: enabled(controls, 7),
        getter_cache: enabled(controls, 8),
        fine_grained_dom: enabled(controls, 9),
        optimize: enabled(controls, 10),
        optimize_level: if enabled(controls, 11) {
            OptimizeLevel::Full
        } else {
            OptimizeLevel::Safe
        },
        inline_derived_memos: enabled(controls, 12),
        preview,
        ..CompilerOptions::default()
    };
    if enabled(controls, 13) {
        options.reactive_scopes = vec!["createScope".into(), "Runtime.scope".into()];
    }
    options.typescript.allow_namespaces = enabled(controls, 14);
    options.typescript.only_remove_type_imports = enabled(controls, 15);
    options.typescript.optimize_const_enums = enabled(controls, 16);
    options.typescript.optimize_enums = enabled(controls, 17);
    options.typescript.rewrite_import_extensions = enabled(controls, 18);
    options.typescript.remove_class_fields_without_initializer = enabled(controls, 19);

    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: filename.clone(),
        module_id: Some(format!("{filename}?fuzz={controls:016x}#request")),
        public_module_id: options.preview.as_ref().map(|_| "fuzz/request".into()),
        language: Some(language),
        module_kind: Some(module_kind),
        input_source_map: enabled(controls, 20).then(|| input_source_map(source)),
        options,
        metadata: vec![metadata_input(controls)],
        integration_diagnostics: Vec::new(),
    }
}

fn input_source_map(source: &str) -> RawSourceMap {
    RawSourceMap {
        version: 3,
        file: Some("compiler-request.generated.tsx".into()),
        source_root: None,
        sources: vec!["/fuzz/original.tsx".into()],
        sources_content: Some(vec![Some(source.into())]),
        names: Vec::new(),
        mappings: "AAAA".into(),
        ignore_list: Vec::new(),
    }
}

fn metadata_input(controls: u64) -> ResolvedMetadataInput {
    let status = match (controls >> 21) & 0b11 {
        0 => MetadataResolutionStatus::Resolved,
        1 => MetadataResolutionStatus::Opaque,
        2 => MetadataResolutionStatus::Missing,
        _ => MetadataResolutionStatus::IncompleteCycle,
    };
    let mut metadata = ModuleReactiveMetadata::new();
    metadata
        .exports
        .insert("signal".into(), ReactiveExportKind::Signal);
    metadata
        .exports
        .insert("memo".into(), ReactiveExportKind::Memo);
    metadata
        .exports
        .insert("__proto__".into(), ReactiveExportKind::Store);
    metadata.hooks.insert(
        "useDependency".into(),
        HookReturnInfo {
            object_props: [("value".into(), ReactiveExportKind::Signal)].into(),
            ..HookReturnInfo::default()
        },
    );
    let carries_metadata = status == MetadataResolutionStatus::Resolved
        || (status == MetadataResolutionStatus::IncompleteCycle && enabled(controls, 25));
    ResolvedMetadataInput {
        request: "./dependency".into(),
        resolved_id: (status != MetadataResolutionStatus::Missing)
            .then(|| "/fuzz/dependency.tsx".into()),
        status,
        metadata: carries_metadata.then_some(metadata),
        fingerprint: format!("sha256:fuzz-{controls:016x}"),
    }
}

fn napi_request_round_trip(request: &CompileRequest) -> CompileRequest {
    let value = serde_json::to_value(request).expect("public requests must serialize");
    assert!(
        value.is_object(),
        "the N-API request boundary requires an object"
    );
    assert_javascript_safe_numbers(&value);
    serde_json::from_value(value).expect("serialized public requests must deserialize")
}

fn validate_result(request: &CompileRequest, result: &CompileResult) {
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.guarantee_class != GuaranteeClass::Internal),
        "supported public request produced an internal diagnostic: {:?}",
        result.diagnostics
    );

    let value = serde_json::to_value(result).expect("public results must serialize");
    assert!(
        value.is_object(),
        "the N-API result boundary requires an object"
    );
    assert_javascript_safe_numbers(&value);
    let round_trip: CompileResult =
        serde_json::from_value(value).expect("serialized public results must deserialize");
    assert_eq!(&round_trip, result);

    if result.has_errors() {
        assert!(result.code.is_empty());
        assert!(result.map.is_none());
        assert!(result.artifacts.is_empty());
        return;
    }

    validate_generated_module(&result.code, request.module_kind, "/fuzz/output.js");
    if request.options.sourcemap {
        let map = result
            .map
            .as_ref()
            .expect("successful source-map requests must return a map");
        map.validate()
            .expect("generated source map must be self-consistent");
        if request.input_source_map.is_some() && !result.code.is_empty() {
            assert!(
                map.sources
                    .iter()
                    .any(|source| source == "/fuzz/original.tsx"),
                "composed map must retain the upstream source identity"
            );
        }
    } else {
        assert!(result.map.is_none());
    }

    let mut artifact_ids = BTreeSet::new();
    for artifact in &result.artifacts {
        assert!(artifact_ids.insert(artifact.id.as_str()));
        validate_generated_module(
            &artifact.code,
            Some(ModuleKind::Module),
            &format!("/fuzz/artifact-{}.js", artifact.id),
        );
        if let Some(map) = &artifact.map {
            map.validate()
                .expect("artifact source map must be self-consistent");
        }
        if let Some(handler) = &artifact.handler {
            assert!(
                usize::try_from(handler.source_span.end())
                    .expect("source spans fit the host address space")
                    <= request.code.len()
            );
            assert!(result.code.contains(&handler.module_specifier));
        }
    }
}

fn validate_generated_module(code: &str, module_kind: Option<ModuleKind>, filename: &str) {
    let parsed = scan(ScanRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: filename.into(),
        module_id: None,
        language: Some(SourceLanguage::JavaScript),
        module_kind,
    });
    assert!(
        !parsed.has_errors(),
        "successful generated output must reparse: {:?}",
        parsed.diagnostics
    );
    assert!(
        parsed
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.guarantee_class != GuaranteeClass::Internal)
    );
}

fn validate_strict_fallback_policy(fallback: &CompileResult, strict: &CompileResult) {
    for diagnostic in &fallback.diagnostics {
        if diagnostic.guarantee_class != GuaranteeClass::Fallback {
            continue;
        }
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
        assert!(strict.diagnostics.iter().any(|candidate| {
            candidate.code == diagnostic.code
                && candidate.guarantee_class == GuaranteeClass::Fallback
                && candidate.severity == DiagnosticSeverity::Error
        }));
    }
    for diagnostic in &strict.diagnostics {
        if diagnostic.guarantee_class != GuaranteeClass::Fallback {
            continue;
        }
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(fallback.diagnostics.iter().any(|candidate| {
            candidate.code == diagnostic.code
                && candidate.guarantee_class == GuaranteeClass::Fallback
                && candidate.severity == DiagnosticSeverity::Warning
        }));
    }
    if !strict.has_errors() {
        assert!(
            !fallback.has_errors(),
            "fallback mode cannot reject a request accepted by strict mode"
        );
    }
}

fn deterministic_result(mut result: CompileResult) -> CompileResult {
    if let Some(stats) = &mut result.stats {
        stats.stage_durations_ns.clear();
    }
    result
}

fn assert_javascript_safe_numbers(value: &Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                assert_javascript_safe_numbers(value);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                assert_javascript_safe_numbers(value);
            }
        }
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                assert!(value <= fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER);
            } else if let Some(value) = number.as_i64() {
                assert!(value.unsigned_abs() <= fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER);
            } else {
                assert!(number.as_f64().is_some_and(f64::is_finite));
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}
