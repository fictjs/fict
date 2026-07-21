/// Statically proven runtime family of a value stored in a shallow `$state` signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StateReceiverKind {
    /// The compiler cannot prove the receiver's built-in identity.
    Unknown,
    /// Array instance.
    Array,
    /// DataView instance.
    DataView,
    /// Date instance.
    Date,
    /// Function value.
    Function,
    /// Map instance.
    Map,
    /// Number or bigint primitive/wrapper.
    Number,
    /// Promise instance.
    Promise,
    /// Set instance.
    Set,
    /// String primitive/wrapper.
    String,
    /// TypedArray instance.
    TypedArray,
    /// WeakMap instance.
    WeakMap,
    /// WeakSet instance.
    WeakSet,
}

/// Receiver-mutation contract for a method called through a `$state`-derived value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StateMethodCallSemantics {
    /// The proven standard method does not mutate its receiver.
    ReadOnlyReceiver,
    /// The method mutates its receiver or the compiler cannot prove that it is read-only.
    MayMutateReceiver,
}

/// Classify a statically named method called through a `$state`-derived value.
///
/// Fict signals are shallow: a receiver mutation does not invoke the signal setter. Method names
/// alone are not proof because a custom object can define a mutating method named `get`, `map`, or
/// `toString`. Read-only certification therefore requires both a proven built-in receiver family
/// and a standard method that does not mutate that family. Unknown receivers fail closed.
#[must_use]
pub fn classify_state_method_call(
    receiver: StateReceiverKind,
    name: &str,
) -> StateMethodCallSemantics {
    let shared_object_read = matches!(
        name,
        "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
    );
    let receiver_read_only = match receiver {
        StateReceiverKind::Unknown => false,
        StateReceiverKind::Array => {
            shared_object_read
                || matches!(
                    name,
                    "at" | "concat"
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
                        | "includes"
                        | "indexOf"
                        | "join"
                        | "keys"
                        | "lastIndexOf"
                        | "map"
                        | "reduce"
                        | "reduceRight"
                        | "slice"
                        | "some"
                        | "toReversed"
                        | "toSorted"
                        | "toSpliced"
                        | "values"
                        | "with"
                )
        }
        StateReceiverKind::DataView => {
            shared_object_read
                || matches!(
                    name,
                    "getBigInt64"
                        | "getBigUint64"
                        | "getFloat32"
                        | "getFloat64"
                        | "getInt8"
                        | "getInt16"
                        | "getInt32"
                        | "getUint8"
                        | "getUint16"
                        | "getUint32"
                )
        }
        StateReceiverKind::Date => {
            shared_object_read
                || matches!(
                    name,
                    "getDate"
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
                        | "toJSON"
                        | "toLocaleDateString"
                        | "toLocaleTimeString"
                        | "toTimeString"
                        | "toUTCString"
                )
        }
        StateReceiverKind::Function => {
            shared_object_read || matches!(name, "apply" | "bind" | "call")
        }
        StateReceiverKind::Map => {
            shared_object_read
                || matches!(
                    name,
                    "entries" | "forEach" | "get" | "has" | "keys" | "values"
                )
        }
        StateReceiverKind::Number => {
            shared_object_read || matches!(name, "toExponential" | "toFixed" | "toPrecision")
        }
        StateReceiverKind::Promise => {
            shared_object_read || matches!(name, "catch" | "finally" | "then")
        }
        StateReceiverKind::Set => {
            shared_object_read
                || matches!(
                    name,
                    "difference"
                        | "entries"
                        | "forEach"
                        | "has"
                        | "intersection"
                        | "isDisjointFrom"
                        | "isSubsetOf"
                        | "isSupersetOf"
                        | "keys"
                        | "symmetricDifference"
                        | "union"
                        | "values"
                )
        }
        StateReceiverKind::String => {
            shared_object_read
                || matches!(
                    name,
                    "at" | "charAt"
                        | "charCodeAt"
                        | "codePointAt"
                        | "concat"
                        | "endsWith"
                        | "includes"
                        | "indexOf"
                        | "isWellFormed"
                        | "lastIndexOf"
                        | "localeCompare"
                        | "match"
                        | "matchAll"
                        | "normalize"
                        | "padEnd"
                        | "padStart"
                        | "repeat"
                        | "replace"
                        | "replaceAll"
                        | "search"
                        | "slice"
                        | "split"
                        | "startsWith"
                        | "substr"
                        | "substring"
                        | "toLocaleLowerCase"
                        | "toLocaleUpperCase"
                        | "toLowerCase"
                        | "toUpperCase"
                        | "toWellFormed"
                        | "trim"
                        | "trimEnd"
                        | "trimStart"
                )
        }
        StateReceiverKind::TypedArray => {
            shared_object_read
                || matches!(
                    name,
                    "at" | "entries"
                        | "every"
                        | "filter"
                        | "find"
                        | "findIndex"
                        | "findLast"
                        | "findLastIndex"
                        | "forEach"
                        | "includes"
                        | "indexOf"
                        | "join"
                        | "keys"
                        | "lastIndexOf"
                        | "map"
                        | "reduce"
                        | "reduceRight"
                        | "slice"
                        | "some"
                        | "subarray"
                        | "toReversed"
                        | "toSorted"
                        | "values"
                        | "with"
                )
        }
        StateReceiverKind::WeakMap => shared_object_read || matches!(name, "get" | "has"),
        StateReceiverKind::WeakSet => shared_object_read || name == "has",
    };
    if receiver_read_only {
        StateMethodCallSemantics::ReadOnlyReceiver
    } else {
        StateMethodCallSemantics::MayMutateReceiver
    }
}

#[cfg(test)]
mod tests {
    use super::{StateMethodCallSemantics, StateReceiverKind, classify_state_method_call};

    #[test]
    fn certifies_methods_only_for_matching_builtin_receivers() {
        for (receiver, name) in [
            (StateReceiverKind::Map, "get"),
            (StateReceiverKind::Set, "has"),
            (StateReceiverKind::Array, "map"),
            (StateReceiverKind::Date, "getTime"),
            (StateReceiverKind::TypedArray, "subarray"),
            (StateReceiverKind::Function, "call"),
        ] {
            assert_eq!(
                classify_state_method_call(receiver, name),
                StateMethodCallSemantics::ReadOnlyReceiver,
                "{receiver:?}.{name}"
            );
        }
    }

    #[test]
    fn fails_closed_for_mutators_mismatched_families_and_unknown_receivers() {
        for (receiver, name) in [
            (StateReceiverKind::Map, "set"),
            (StateReceiverKind::Set, "add"),
            (StateReceiverKind::Array, "push"),
            (StateReceiverKind::Date, "setTime"),
            (StateReceiverKind::Map, "map"),
            (StateReceiverKind::Unknown, "get"),
            (StateReceiverKind::Unknown, "toString"),
        ] {
            assert_eq!(
                classify_state_method_call(receiver, name),
                StateMethodCallSemantics::MayMutateReceiver,
                "{receiver:?}.{name}"
            );
        }
    }
}
