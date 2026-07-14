use std::collections::{BTreeMap, BTreeSet};

use fict_compiler::{CorePassOptions, FunctionPassAnalysis, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{
    BindingKind, FictMacroKind, HirFile, HirFunction, HirInstructionKind, LocalId, LocalKind,
    SsaName,
};
use fict_reactivity::{
    DependencyBase, DependencyPath, DependencySegment, ReactiveBindingKind, ShapeKey, ShapeKind,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisFixture {
    name: String,
    language: String,
    source: String,
    expected: AnalysisSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisSnapshot {
    functions: Vec<FunctionAnalysisSnapshot>,
    has_derived_cycle: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionAnalysisSnapshot {
    name: String,
    reactive_bindings: Vec<ReactiveBindingSnapshot>,
    control_flow_reads: Vec<String>,
    escaping_bindings: Vec<String>,
    shapes: Vec<ShapeSnapshot>,
    region: RegionSnapshot,
    has_effect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactiveBindingSnapshot {
    name: String,
    kind: String,
    dependencies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShapeSnapshot {
    name: String,
    known_keys: Vec<String>,
    mutable_keys: Vec<String>,
    dynamic_access: bool,
    complete_key_set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionSnapshot {
    has_control_flow: bool,
    has_jsx: bool,
    has_async: bool,
}

fn source_language(language: &str) -> OxcSourceLanguage {
    match language {
        "js" => OxcSourceLanguage::JavaScript,
        "jsx" => OxcSourceLanguage::JavaScriptJsx,
        "ts" => OxcSourceLanguage::TypeScript,
        "tsx" => OxcSourceLanguage::TypeScriptJsx,
        other => panic!("unsupported fixture language: {other}"),
    }
}

fn local_name(function: &HirFunction, local: LocalId) -> Option<String> {
    function.locals[local.as_usize()].debug_name.clone()
}

fn user_local_names(file: &HirFile, function: &HirFunction) -> BTreeSet<String> {
    function
        .locals
        .iter()
        .filter(|local| local.kind != LocalKind::Temporary)
        .filter(|local| {
            local
                .binding
                .is_none_or(|binding| file.bindings[binding.as_usize()].kind != BindingKind::Import)
        })
        .filter_map(|local| local.debug_name.clone())
        .collect()
}

fn dependency_path(function: &HirFunction, path: &DependencyPath) -> Option<String> {
    let DependencyBase::Ssa(name) = path.base else {
        return None;
    };
    let mut output = local_name(function, name.local)?;
    for segment in &path.segments {
        match segment {
            DependencySegment::Static { name, .. } => {
                output.push('.');
                output.push_str(name);
            }
            DependencySegment::Index { index, .. } => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            DependencySegment::Dynamic { .. } => output.push_str("[*]"),
        }
    }
    Some(output)
}

fn reactive_kind(kind: ReactiveBindingKind) -> &'static str {
    match kind {
        ReactiveBindingKind::State => "state",
        ReactiveBindingKind::Memo => "memo",
        ReactiveBindingKind::Store => "store",
        ReactiveBindingKind::Resource => "resource",
        ReactiveBindingKind::Selector => "selector",
        ReactiveBindingKind::Alias => "alias",
        ReactiveBindingKind::Derived => "derived",
    }
}

fn reactive_kind_priority(kind: ReactiveBindingKind) -> u8 {
    match kind {
        ReactiveBindingKind::State
        | ReactiveBindingKind::Memo
        | ReactiveBindingKind::Store
        | ReactiveBindingKind::Resource
        | ReactiveBindingKind::Selector => 3,
        ReactiveBindingKind::Alias => 2,
        ReactiveBindingKind::Derived => 1,
    }
}

fn normalize_reactive_bindings(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    user_names: &BTreeSet<String>,
) -> Vec<ReactiveBindingSnapshot> {
    #[rustfmt::skip]
    let has_root = analysis.scopes.bindings.iter().any(|binding| reactive_kind_priority(binding.kind) == 3);
    if !has_root {
        return Vec::new();
    }
    let mut grouped: BTreeMap<String, (ReactiveBindingKind, BTreeSet<String>)> = BTreeMap::new();
    for binding in &analysis.scopes.bindings {
        let Some(name) = local_name(function, binding.name.local) else {
            continue;
        };
        if !user_names.contains(&name) {
            continue;
        }
        let entry = grouped
            .entry(name)
            .or_insert_with(|| (binding.kind, BTreeSet::new()));
        if reactive_kind_priority(binding.kind) > reactive_kind_priority(entry.0) {
            entry.0 = binding.kind;
        }
        entry.1.extend(
            binding
                .dependencies
                .iter()
                .filter_map(|path| dependency_path(function, path)),
        );
    }
    let reactive_names: BTreeSet<_> = grouped.keys().cloned().collect();
    grouped
        .into_iter()
        .map(|(name, (kind, dependencies))| ReactiveBindingSnapshot {
            name,
            kind: reactive_kind(kind).to_owned(),
            dependencies: dependencies
                .into_iter()
                .filter(|path| {
                    path.split(['.', '['])
                        .next()
                        .is_some_and(|base| reactive_names.contains(base))
                })
                .collect(),
        })
        .collect()
}

fn shape_key(key: &ShapeKey) -> String {
    match key {
        ShapeKey::Static(name) => name.clone(),
        ShapeKey::Index(index) => index.to_string(),
    }
}

fn normalize_shapes(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    user_names: &BTreeSet<String>,
) -> Vec<ShapeSnapshot> {
    let mut accessed_keys: BTreeMap<LocalId, BTreeSet<String>> = BTreeMap::new();
    for access in &analysis.shapes.property_accesses {
        let DependencyBase::Ssa(name) = access.path.base else {
            continue;
        };
        let Some(key) = access
            .path
            .segments
            .first()
            .and_then(|segment| match segment {
                DependencySegment::Static { name, .. } => Some(name.clone()),
                DependencySegment::Index { index, .. } => Some(index.to_string()),
                DependencySegment::Dynamic { .. } => None,
            })
        else {
            continue;
        };
        accessed_keys.entry(name.local).or_default().insert(key);
    }
    let mut latest: BTreeMap<LocalId, (SsaName, &fict_reactivity::ValueShape)> = BTreeMap::new();
    for fact in &analysis.shapes.shapes {
        latest
            .entry(fact.name.local)
            .and_modify(|entry| {
                if fact.name.version > entry.0.version {
                    *entry = (fact.name, &fact.shape);
                }
            })
            .or_insert((fact.name, &fact.shape));
    }
    let mut snapshots: Vec<_> = latest
        .into_iter()
        .filter_map(|(local, (_, shape))| {
            let name = local_name(function, local)?;
            if !user_names.contains(&name)
                || (!matches!(shape.kind, ShapeKind::Object | ShapeKind::Array)
                    && shape.known_keys.is_empty()
                    && !shape.dynamic_access)
            {
                return None;
            }
            let known_keys = shape
                .known_keys
                .iter()
                .map(shape_key)
                .chain(accessed_keys.get(&local).into_iter().flatten().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            Some(ShapeSnapshot {
                name,
                known_keys,
                mutable_keys: shape.mutable_keys.iter().map(shape_key).collect(),
                dynamic_access: shape.dynamic_access,
                complete_key_set: shape.complete_key_set,
            })
        })
        .collect();
    snapshots.sort_by(|left, right| left.name.cmp(&right.name));
    snapshots
}

fn function_has_effect(function: &HirFunction) -> bool {
    function.blocks.iter().any(|block| {
        block.instructions.iter().any(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Call(call) if call.macro_kind == Some(FictMacroKind::Effect)
            )
        })
    })
}

fn function_name<'a>(file: &'a HirFile, function: &HirFunction) -> Option<&'a str> {
    function
        .binding
        .map(|binding| file.bindings[binding.as_usize()].display_name.as_str())
}

fn normalize_function(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
) -> Option<FunctionAnalysisSnapshot> {
    let name = function_name(file, function)?.to_owned();
    let user_names = user_local_names(file, function);
    let control_flow_reads = analysis
        .dependencies
        .control_flow_reads
        .iter()
        .filter_map(|path| dependency_path(function, path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let escaping_bindings = analysis
        .dependencies
        .escapes
        .iter()
        .filter_map(|escape| escape.path.local())
        .filter_map(|local| local_name(function, local))
        .filter(|name| user_names.contains(name))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Some(FunctionAnalysisSnapshot {
        name,
        reactive_bindings: normalize_reactive_bindings(function, analysis, &user_names),
        control_flow_reads,
        escaping_bindings,
        shapes: normalize_shapes(function, analysis, &user_names),
        region: RegionSnapshot {
            has_control_flow: analysis
                .regions
                .regions
                .iter()
                .any(|region| region.has_control_flow),
            has_jsx: analysis.regions.regions.iter().any(|region| region.has_jsx),
            has_async: analysis
                .regions
                .regions
                .iter()
                .any(|region| region.has_async),
        },
        has_effect: function_has_effect(function),
    })
}

fn analyze(fixture: &AnalysisFixture) -> AnalysisSnapshot {
    let build = build_hir(
        &fixture.source,
        OxcCompileOptions {
            language: source_language(&fixture.language),
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    let hir = build.hir.unwrap_or_else(|| {
        panic!(
            "analysis fixture {} failed frontend build: {:?}",
            fixture.name, build.diagnostics
        )
    });
    let output = run_core_passes(
        &hir,
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .unwrap_or_else(|diagnostics| {
        panic!(
            "analysis fixture {} failed core passes: {:?}",
            fixture.name, diagnostics
        )
    });
    let mut functions: Vec<_> = output
        .hir
        .functions
        .iter()
        .filter(|function| function.id != output.hir.root_function)
        .filter_map(|function| {
            normalize_function(
                &output.hir,
                function,
                &output.functions[function.id.as_usize()],
            )
        })
        .collect();
    functions.sort_by(|left, right| left.name.cmp(&right.name));
    AnalysisSnapshot {
        has_derived_cycle: output
            .functions
            .iter()
            .any(|analysis| !analysis.cycles.cycles.is_empty()),
        functions,
    }
}

#[test]
fn rust_analysis_matches_the_shared_legacy_normalized_corpus() {
    let fixtures: Vec<AnalysisFixture> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/compiler/test/differential/analysis-parity-fixtures.json"
    )))
    .expect("valid analysis parity fixtures");

    for fixture in fixtures {
        assert_eq!(
            analyze(&fixture),
            fixture.expected,
            "normalized analysis differs for {}",
            fixture.name
        );
    }
}
