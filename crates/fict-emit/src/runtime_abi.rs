/// Runtime import family selected from source imports/module configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuntimeFamily {
    /// `fict/internal` compatibility family.
    Fict,
    /// `@fictjs/runtime/internal` package family.
    Runtime,
}

/// Runtime subpath that owns a helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuntimeHelperModule {
    /// Main compiler/runtime ABI barrel.
    Internal,
    /// Narrow keyed-list helper subpath.
    List,
}

/// Whether a helper belongs to Core or optional Preview emission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuntimeHelperStability {
    /// Core compiler ABI.
    Core,
    /// Preview/resumability-only ABI.
    Preview,
}

/// Generated immutable helper contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeHelperSpec {
    /// Strong helper identity.
    pub helper: RuntimeHelper,
    /// Stable manifest key.
    pub key: &'static str,
    /// Exported runtime symbol.
    pub export: &'static str,
    /// Preferred collision-free local spelling.
    pub preferred_local: &'static str,
    /// Owning subpath.
    pub module: RuntimeHelperModule,
    /// Core or Preview ownership.
    pub stability: RuntimeHelperStability,
}

include!("runtime_abi.generated.rs");

impl RuntimeHelper {
    /// Return this helper's generated ABI specification.
    #[must_use]
    pub fn spec(self) -> &'static RuntimeHelperSpec {
        &RUNTIME_HELPER_SPECS[self as usize]
    }

    /// Resolve a manifest key to a strong helper identity.
    #[must_use]
    pub fn from_key(key: &str) -> Option<Self> {
        RUNTIME_HELPER_SPECS
            .iter()
            .find(|spec| spec.key == key)
            .map(|spec| spec.helper)
    }
}

impl RuntimeHelperSpec {
    /// Runtime module request for one import family.
    #[must_use]
    pub const fn module_request(self, family: RuntimeFamily) -> &'static str {
        match (family, self.module) {
            (RuntimeFamily::Fict, RuntimeHelperModule::Internal) => FICT_INTERNAL_MODULE,
            (RuntimeFamily::Fict, RuntimeHelperModule::List) => FICT_LIST_MODULE,
            (RuntimeFamily::Runtime, RuntimeHelperModule::Internal) => STANDALONE_INTERNAL_MODULE,
            (RuntimeFamily::Runtime, RuntimeHelperModule::List) => STANDALONE_LIST_MODULE,
        }
    }
}

/// Verify generated ordering, uniqueness, and Core/Preview separation.
pub fn verify_runtime_abi() -> Result<(), &'static str> {
    if ALL_RUNTIME_HELPERS.len() != RUNTIME_HELPER_SPECS.len() {
        return Err("runtime helper enum/spec arenas differ");
    }
    for (index, spec) in RUNTIME_HELPER_SPECS.iter().enumerate() {
        if spec.helper as usize != index || ALL_RUNTIME_HELPERS[index] != spec.helper {
            return Err("runtime helper generated ordering is inconsistent");
        }
        if RUNTIME_HELPER_SPECS[..index]
            .iter()
            .any(|previous| previous.key == spec.key)
        {
            return Err("runtime helper key is duplicated");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        RUNTIME_ABI_VERSION, RuntimeFamily, RuntimeHelper, RuntimeHelperModule,
        RuntimeHelperStability, verify_runtime_abi,
    };

    #[test]
    fn generated_registry_is_unique_and_routes_subpaths() {
        assert_eq!(RUNTIME_ABI_VERSION, 1);
        verify_runtime_abi().expect("valid generated runtime ABI");
        let keyed = RuntimeHelper::from_key("keyedList").expect("keyed list helper");
        assert_eq!(keyed.spec().module, RuntimeHelperModule::List);
        assert_eq!(
            keyed.spec().module_request(RuntimeFamily::Runtime),
            "@fictjs/runtime/internal/list"
        );
        assert_eq!(
            RuntimeHelper::Qrl.spec().stability,
            RuntimeHelperStability::Preview
        );
        assert!(RuntimeHelper::from_key("missing").is_none());
    }
}
