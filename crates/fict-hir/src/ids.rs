use std::fmt;

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(u32);

        impl $name {
            /// Construct an ID from its deterministic arena index.
            #[must_use]
            pub const fn new(index: u32) -> Self {
                Self(index)
            }

            /// Return the deterministic arena index.
            #[must_use]
            pub const fn index(self) -> u32 {
                self.0
            }

            /// Return the index in the form accepted by Rust slices.
            #[must_use]
            pub const fn as_usize(self) -> usize {
                self.0 as usize
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}", self.0)
            }
        }
    };
}

define_id!(
    /// Identity of one source file in a compilation request.
    FileId
);
define_id!(
    /// Identity of a function, including the synthetic module function.
    FunctionId
);
define_id!(
    /// Identity of a lexical or semantic scope.
    ScopeId
);
define_id!(
    /// Identity of one control-flow block.
    BlockId
);
define_id!(
    /// Identity of one function-local storage location.
    LocalId
);
define_id!(
    /// Identity of one evaluated HIR value.
    ValueId
);
define_id!(
    /// Identity of one reactive region.
    RegionId
);
define_id!(
    /// Identity of one JSX template.
    TemplateId
);
define_id!(
    /// Semantic binding identity resolved by the frontend.
    BindingId
);
define_id!(
    /// Adapter-owned syntax retained outside the compiler core.
    SyntaxFragmentId
);

/// Monotonic SSA version for a function-local storage location.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SsaVersion(u32);

impl SsaVersion {
    /// Initial SSA version assigned to a local definition.
    pub const INITIAL: Self = Self(0);

    /// Construct an SSA version.
    #[must_use]
    pub const fn new(version: u32) -> Self {
        Self(version)
    }

    /// Return the numeric version.
    #[must_use]
    pub const fn index(self) -> u32 {
        self.0
    }
}

/// SSA identity represented structurally instead of by mutating a user-visible name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SsaName {
    /// Storage location being versioned.
    pub local: LocalId,
    /// Definition version within the function.
    pub version: SsaVersion,
}

impl SsaName {
    /// Construct a structural SSA identity.
    #[must_use]
    pub const fn new(local: LocalId, version: SsaVersion) -> Self {
        Self { local, version }
    }
}

#[cfg(test)]
mod tests {
    use super::{BindingId, LocalId, SsaName, SsaVersion};

    #[test]
    fn ids_expose_stable_indices_without_name_encoding() {
        let binding = BindingId::new(7);
        let local = LocalId::new(7);
        let ssa = SsaName::new(local, SsaVersion::new(3));

        assert_eq!(binding.index(), 7);
        assert_eq!(local.as_usize(), 7);
        assert_eq!(ssa.local, local);
        assert_eq!(ssa.version.index(), 3);
    }
}
