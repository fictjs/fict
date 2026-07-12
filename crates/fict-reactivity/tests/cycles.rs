use fict_hir::{
    BlockId, DeclarationKind, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFunction,
    HirLocal, HirTerminator, LocalId, LocalKind, Origin, ScopeId, SourceSpan, SsaName, SsaVersion,
    TerminatorKind,
};
use fict_reactivity::{
    DependencyBase, DependencyPath, ReactiveBindingFact, ReactiveBindingKind, ReactiveCycleKind,
    ReactiveScopeAnalysis, ReactiveScopeStats, analyze_reactive_cycles, verify_reactive_cycles,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn name(local: u32, version: u32) -> SsaName {
    SsaName::new(LocalId::new(local), SsaVersion::new(version))
}

fn local(id: u32) -> HirLocal {
    HirLocal {
        id: LocalId::new(id),
        binding: None,
        scope: ScopeId::new(0),
        kind: LocalKind::User,
        declaration_kind: DeclarationKind::Const,
        debug_name: Some(format!("local_{id}")),
        origin: origin(),
    }
}

fn function(local_count: u32) -> HirFunction {
    HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: (0..local_count).map(local).collect(),
        values: Vec::new(),
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Return { value: None },
                origin: origin(),
            },
            source_hint: None,
            origin: origin(),
        }],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    }
}

fn path(local: u32, version: u32) -> DependencyPath {
    DependencyPath {
        base: DependencyBase::Ssa(name(local, version)),
        segments: Vec::new(),
    }
}

fn binding(
    local: u32,
    kind: ReactiveBindingKind,
    dependencies: Vec<DependencyPath>,
) -> ReactiveBindingFact {
    ReactiveBindingFact {
        name: name(local, 1),
        kind,
        dependencies,
        location: fict_reactivity::SsaDefinitionLocation::Instruction {
            block: BlockId::new(0),
            instruction: local,
        },
    }
}

#[test]
fn detects_forward_reference_scc_and_keeps_state_as_cycle_breaker() {
    let function = function(3);
    let scopes = ReactiveScopeAnalysis {
        bindings: vec![
            binding(0, ReactiveBindingKind::State, Vec::new()),
            binding(
                1,
                ReactiveBindingKind::Derived,
                vec![path(0, 1), path(2, 0)],
            ),
            binding(2, ReactiveBindingKind::Derived, vec![path(1, 1)]),
        ],
        blocks: Vec::new(),
        stats: ReactiveScopeStats::default(),
    };
    let analysis = analyze_reactive_cycles(&function, &scopes).expect("cycle graph");

    assert_eq!(analysis.edges.len(), 3);
    assert_eq!(analysis.evaluation_groups.len(), 2);
    assert_eq!(analysis.evaluation_groups[0], [name(0, 1)]);
    assert_eq!(analysis.evaluation_groups[1], [name(1, 1), name(2, 1)]);
    assert_eq!(analysis.cycles.len(), 1);
    assert_eq!(analysis.cycles[0].kind, ReactiveCycleKind::MutualDerived);
    assert_eq!(analysis.cycles[0].nodes, [name(1, 1), name(2, 1)]);
    assert_eq!(analysis.cycles[0].edges.len(), 2);
    assert_eq!(analysis.cycles[0].blocks, [BlockId::new(0)]);

    let mut corrupted = analysis.clone();
    corrupted.evaluation_groups.swap(0, 1);
    let diagnostics = verify_reactive_cycles(&function, &scopes, &corrupted)
        .expect_err("consumer-before-producer order");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-CYCLE-ORDER")
    );
}

#[test]
fn reports_a_single_derived_self_reference() {
    let function = function(1);
    let scopes = ReactiveScopeAnalysis {
        bindings: vec![binding(0, ReactiveBindingKind::Derived, vec![path(0, 0)])],
        blocks: Vec::new(),
        stats: ReactiveScopeStats::default(),
    };
    let analysis = analyze_reactive_cycles(&function, &scopes).expect("self cycle graph");
    assert_eq!(analysis.cycles.len(), 1);
    assert_eq!(analysis.cycles[0].kind, ReactiveCycleKind::SelfReference);
    assert_eq!(analysis.cycles[0].nodes, [name(0, 1)]);
}
