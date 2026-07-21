use std::collections::BTreeSet;

/// Deterministic allocator shared by module imports and generated function temporaries.
///
/// Every source binding and authored free identifier is reserved across the module, including
/// nested bindings. This is more conservative than lexical reuse but guarantees that generated
/// references cannot capture host/global lookups or be captured by a user declaration in another
/// function when an EmitIR operation is later moved or outlined.
#[derive(Debug, Clone, Default)]
pub(crate) struct NameAllocator {
    reserved: BTreeSet<String>,
}

impl NameAllocator {
    pub(crate) fn new(names: impl IntoIterator<Item = String>) -> Self {
        let mut allocator = Self::default();
        allocator.reserved.extend(
            [
                "arguments",
                "await",
                "eval",
                "Infinity",
                "NaN",
                "undefined",
                "yield",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        allocator.reserved.extend(names);
        allocator
    }

    pub(crate) fn allocate(&mut self, preferred: &str) -> String {
        if self.reserved.insert(preferred.to_owned()) {
            return preferred.to_owned();
        }
        let mut index = 1_u32;
        loop {
            let candidate = format!("{preferred}_{index}");
            if self.reserved.insert(candidate.clone()) {
                return candidate;
            }
            index = index.saturating_add(1);
        }
    }

    pub(crate) fn names(&self) -> Vec<String> {
        self.reserved.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::NameAllocator;

    #[test]
    fn allocates_stable_suffixes_and_reserves_dangerous_globals() {
        let mut allocator =
            NameAllocator::new(["createSignal".to_owned(), "createSignal_1".to_owned()]);
        assert_eq!(allocator.allocate("createSignal"), "createSignal_2");
        assert_eq!(allocator.allocate("createSignal"), "createSignal_3");
        assert_eq!(allocator.allocate("undefined"), "undefined_1");
        assert!(allocator.names().windows(2).all(|pair| pair[0] < pair[1]));
    }
}
