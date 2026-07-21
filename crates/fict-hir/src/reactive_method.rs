/// Receiver-mutation contract for a method called through a `$state`-derived value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StateMethodCallSemantics {
    /// The standard method does not mutate its receiver.
    ReadOnlyReceiver,
    /// The method mutates its receiver or the compiler cannot prove that it is read-only.
    MayMutateReceiver,
}

/// Classify a statically named method called through a `$state`-derived value.
///
/// Fict signals are shallow: a receiver mutation does not invoke the signal setter. Unknown and
/// custom method names therefore fail closed as potentially mutating. This allowlist contains
/// standard collection, string, number, date, promise, and view methods whose specified operation
/// does not mutate the receiver itself.
#[must_use]
pub fn classify_state_method_call(name: &str) -> StateMethodCallSemantics {
    if matches!(
        name,
        // Shared Object and primitive inspection.
        "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toExponential"
            | "toFixed"
            | "toJSON"
            | "toLocaleDateString"
            | "toLocaleLowerCase"
            | "toLocaleString"
            | "toLocaleTimeString"
            | "toLocaleUpperCase"
            | "toPrecision"
            | "toString"
            | "valueOf"
            // Arrays, typed arrays, maps, sets, and strings.
            | "at"
            | "charAt"
            | "charCodeAt"
            | "codePointAt"
            | "concat"
            | "difference"
            | "endsWith"
            | "entries"
            | "every"
            | "filter"
            | "find"
            | "findIndex"
            | "findLast"
            | "findLastIndex"
            | "flat"
            | "flatMap"
            | "forEach"
            | "get"
            | "has"
            | "includes"
            | "indexOf"
            | "intersection"
            | "isDisjointFrom"
            | "isSubsetOf"
            | "isSupersetOf"
            | "isWellFormed"
            | "join"
            | "keys"
            | "lastIndexOf"
            | "localeCompare"
            | "map"
            | "match"
            | "matchAll"
            | "normalize"
            | "padEnd"
            | "padStart"
            | "reduce"
            | "reduceRight"
            | "repeat"
            | "replace"
            | "replaceAll"
            | "search"
            | "slice"
            | "some"
            | "split"
            | "startsWith"
            | "subarray"
            | "substr"
            | "substring"
            | "symmetricDifference"
            | "toLowerCase"
            | "toReversed"
            | "toSorted"
            | "toSpliced"
            | "toUpperCase"
            | "toWellFormed"
            | "trim"
            | "trimEnd"
            | "trimStart"
            | "union"
            | "values"
            | "with"
            // Date reads.
            | "getDate"
            | "getDay"
            | "getFullYear"
            | "getHours"
            | "getMilliseconds"
            | "getMinutes"
            | "getMonth"
            | "getSeconds"
            | "getTime"
            | "getTimezoneOffset"
            | "getUTCDate"
            | "getUTCDay"
            | "getUTCFullYear"
            | "getUTCHours"
            | "getUTCMilliseconds"
            | "getUTCMinutes"
            | "getUTCMonth"
            | "getUTCSeconds"
            | "getYear"
            | "toDateString"
            | "toISOString"
            | "toTimeString"
            | "toUTCString"
            // DataView reads.
            | "getBigInt64"
            | "getBigUint64"
            | "getFloat32"
            | "getFloat64"
            | "getInt8"
            | "getInt16"
            | "getInt32"
            | "getUint8"
            | "getUint16"
            | "getUint32"
            // Promise chaining creates a new promise without mutating the receiver.
            | "catch"
            | "finally"
            | "then"
    ) {
        StateMethodCallSemantics::ReadOnlyReceiver
    } else {
        StateMethodCallSemantics::MayMutateReceiver
    }
}

#[cfg(test)]
mod tests {
    use super::{StateMethodCallSemantics, classify_state_method_call};

    #[test]
    fn classifies_readonly_builtins_and_fails_closed_for_mutators_or_unknowns() {
        for name in ["get", "has", "map", "includes", "getTime", "subarray"] {
            assert_eq!(
                classify_state_method_call(name),
                StateMethodCallSemantics::ReadOnlyReceiver,
                "{name}"
            );
        }
        for name in [
            "set",
            "add",
            "clear",
            "delete",
            "push",
            "setTime",
            "customMutator",
        ] {
            assert_eq!(
                classify_state_method_call(name),
                StateMethodCallSemantics::MayMutateReceiver,
                "{name}"
            );
        }
    }
}
