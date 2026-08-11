#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct EffectSet(u8);

impl EffectSet {
    pub(super) const READ: Self = Self(1 << 0);
    pub(super) const CALL_SYNC: Self = Self(1 << 1);
    pub(super) const RETAIN: Self = Self(1 << 2);
    pub(super) const WRITE_TARGET: Self = Self(1 << 3);
    pub(super) const RETURN_ALIAS: Self = Self(1 << 4);
    pub(super) const MAY_THROW: Self = Self(1 << 5);

    const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub(super) const fn contains(self, effect: Self) -> bool {
        self.0 & effect.0 == effect.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BuiltinArgumentEffect {
    pub(super) index: usize,
    pub(super) effects: EffectSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BuiltinEffect {
    pub(super) owner: &'static str,
    pub(super) method: &'static str,
    pub(super) arguments: &'static [BuiltinArgumentEffect],
}

const NON_RETAINING_READ_TARGET: EffectSet = EffectSet::READ.union(EffectSet::MAY_THROW);
const NON_RETAINING_WRITE_TARGET: EffectSet = EffectSet::READ
    .union(EffectSet::WRITE_TARGET)
    .union(EffectSet::MAY_THROW);
const NON_RETAINING_RETURNED_TARGET: EffectSet =
    NON_RETAINING_WRITE_TARGET.union(EffectSet::RETURN_ALIAS);
const SYNCHRONOUS_CALL_TARGET: EffectSet = EffectSet::CALL_SYNC.union(EffectSet::MAY_THROW);

const ARG0_READ: &[BuiltinArgumentEffect] = &[BuiltinArgumentEffect {
    index: 0,
    effects: NON_RETAINING_READ_TARGET,
}];
const ARG0_WRITE: &[BuiltinArgumentEffect] = &[BuiltinArgumentEffect {
    index: 0,
    effects: NON_RETAINING_WRITE_TARGET,
}];
const ARG0_WRITE_RETURN: &[BuiltinArgumentEffect] = &[BuiltinArgumentEffect {
    index: 0,
    effects: NON_RETAINING_RETURNED_TARGET,
}];
const ARG0_CALL_SYNC: &[BuiltinArgumentEffect] = &[BuiltinArgumentEffect {
    index: 0,
    effects: SYNCHRONOUS_CALL_TARGET,
}];

const BUILTINS: &[BuiltinEffect] = &[
    BuiltinEffect {
        owner: "Object",
        method: "assign",
        arguments: ARG0_WRITE_RETURN,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "apply",
        arguments: ARG0_CALL_SYNC,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "construct",
        arguments: ARG0_CALL_SYNC,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "defineProperty",
        arguments: ARG0_WRITE,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "deleteProperty",
        arguments: ARG0_WRITE,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "get",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "getOwnPropertyDescriptor",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "getPrototypeOf",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "has",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "isExtensible",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "ownKeys",
        arguments: ARG0_READ,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "preventExtensions",
        arguments: ARG0_WRITE,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "set",
        arguments: ARG0_WRITE,
    },
    BuiltinEffect {
        owner: "Reflect",
        method: "setPrototypeOf",
        arguments: ARG0_WRITE,
    },
];

pub(super) fn lookup(owner: &str, method: &str) -> Option<&'static BuiltinEffect> {
    BUILTINS
        .iter()
        .find(|effect| effect.owner == owner && effect.method == method)
}

impl BuiltinEffect {
    pub(super) fn argument(&self, index: usize) -> Option<BuiltinArgumentEffect> {
        self.arguments
            .iter()
            .find(|argument| argument.index == index)
            .copied()
    }
}

#[cfg(test)]
mod tests {
    use super::{EffectSet, lookup};

    #[test]
    fn target_effects_are_declared_by_argument() {
        let assign = lookup("Object", "assign").expect("Object.assign summary");
        let target = assign.argument(0).expect("target argument");
        assert!(target.effects.contains(EffectSet::WRITE_TARGET));
        assert!(target.effects.contains(EffectSet::RETURN_ALIAS));
        assert!(!target.effects.contains(EffectSet::RETAIN));

        let construct = lookup("Reflect", "construct").expect("Reflect.construct summary");
        assert!(
            construct
                .argument(0)
                .expect("constructor argument")
                .effects
                .contains(EffectSet::CALL_SYNC)
        );
        assert!(construct.argument(1).is_none());
    }
}
