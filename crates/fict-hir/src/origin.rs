use fict_diagnostics::SourceSpan;

/// Why source syntax was normalized before entering HIR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DesugaringKind {
    /// TypeScript-only syntax was erased or normalized.
    TypeScript,
    /// A binding pattern was expanded into explicit operations.
    Pattern,
    /// Optional chaining was expanded into control flow.
    OptionalChain,
    /// A logical assignment was expanded into reads and writes.
    LogicalAssignment,
    /// Loop syntax was normalized into control-flow blocks.
    Loop,
    /// JSX syntax was normalized into a template and dynamic values.
    Jsx,
    /// A class-related construct was normalized.
    Class,
    /// Decorator syntax was normalized or preserved as a controlled fragment.
    Decorator,
}

/// Purpose of compiler-generated HIR that has no direct one-to-one source node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GeneratedOrigin {
    /// A compiler-only local or value.
    Temporary,
    /// A block or edge introduced while building control flow.
    ControlFlow,
    /// Runtime setup that implements source semantics.
    RuntimeScaffolding,
    /// A value created while materializing a reactive region.
    ReactiveRegion,
    /// A bookkeeping operation that should normally remain unmapped.
    Bookkeeping,
}

/// Classification of the relationship between HIR and source text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum OriginKind {
    /// The HIR node directly represents its primary source span.
    Source,
    /// The HIR node was produced by a known source normalization.
    Desugared(DesugaringKind),
    /// The HIR node was introduced by the compiler.
    Generated(GeneratedOrigin),
}

/// Source provenance retained across frontend, analysis, and emission passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Origin {
    /// Primary user-authored byte span, if this node should map to source.
    pub primary_span: Option<SourceSpan>,
    /// How the node relates to that source span.
    pub kind: OriginKind,
}

impl Origin {
    /// Construct provenance for a node that directly represents source syntax.
    #[must_use]
    pub const fn source(span: SourceSpan) -> Self {
        Self {
            primary_span: Some(span),
            kind: OriginKind::Source,
        }
    }

    /// Construct provenance for a normalized source construct.
    #[must_use]
    pub const fn desugared(span: SourceSpan, kind: DesugaringKind) -> Self {
        Self {
            primary_span: Some(span),
            kind: OriginKind::Desugared(kind),
        }
    }

    /// Construct provenance for generated HIR, optionally anchored to user source.
    #[must_use]
    pub const fn generated(primary_span: Option<SourceSpan>, purpose: GeneratedOrigin) -> Self {
        Self {
            primary_span,
            kind: OriginKind::Generated(purpose),
        }
    }

    /// Return whether source-map emission should consider this origin mapped.
    #[must_use]
    pub const fn is_mapped(self) -> bool {
        self.primary_span.is_some()
    }
}

#[cfg(test)]
mod tests {
    use fict_diagnostics::SourceSpan;

    use super::{GeneratedOrigin, Origin, OriginKind};

    #[test]
    fn generated_bookkeeping_can_remain_unmapped() {
        let origin = Origin::generated(None, GeneratedOrigin::Bookkeeping);
        assert!(!origin.is_mapped());
        assert_eq!(
            origin.kind,
            OriginKind::Generated(GeneratedOrigin::Bookkeeping)
        );

        let mapped = Origin::generated(SourceSpan::new(2, 4), GeneratedOrigin::RuntimeScaffolding);
        assert!(mapped.is_mapped());
    }
}
