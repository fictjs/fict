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

/// Classify the built-in family returned by a method on a proven shallow-state receiver.
///
/// Returning [`StateReceiverKind::Unknown`] means that a later chained method call must fail
/// closed. The receiver family is part of the proof: a custom method named `map`, `then`, or
/// `slice` is not enough to certify the result.
#[must_use]
pub fn classify_state_method_result(
    receiver: StateReceiverKind,
    method: &str,
) -> StateReceiverKind {
    match receiver {
        StateReceiverKind::Array
            if matches!(
                method,
                "concat"
                    | "filter"
                    | "flat"
                    | "flatMap"
                    | "map"
                    | "slice"
                    | "toReversed"
                    | "toSorted"
                    | "toSpliced"
                    | "with"
            ) =>
        {
            StateReceiverKind::Array
        }
        StateReceiverKind::TypedArray
            if matches!(
                method,
                "filter" | "map" | "slice" | "subarray" | "toReversed" | "toSorted" | "with"
            ) =>
        {
            StateReceiverKind::TypedArray
        }
        StateReceiverKind::Set
            if matches!(
                method,
                "add" | "difference" | "intersection" | "symmetricDifference" | "union"
            ) =>
        {
            StateReceiverKind::Set
        }
        StateReceiverKind::Map if method == "set" => StateReceiverKind::Map,
        StateReceiverKind::Function if method == "bind" => StateReceiverKind::Function,
        StateReceiverKind::Promise if matches!(method, "catch" | "finally" | "then") => {
            StateReceiverKind::Promise
        }
        StateReceiverKind::String
            if matches!(
                method,
                "concat"
                    | "normalize"
                    | "padEnd"
                    | "padStart"
                    | "repeat"
                    | "replace"
                    | "replaceAll"
                    | "slice"
                    | "substring"
                    | "toLocaleLowerCase"
                    | "toLocaleUpperCase"
                    | "toLowerCase"
                    | "toUpperCase"
                    | "toWellFormed"
                    | "trim"
                    | "trimEnd"
                    | "trimStart"
                    | "valueOf"
            ) =>
        {
            StateReceiverKind::String
        }
        StateReceiverKind::Number if method == "valueOf" => StateReceiverKind::Number,
        _ => StateReceiverKind::Unknown,
    }
}

/// Classify scalar properties exposed by a proven shallow-state built-in receiver.
///
/// Unknown and custom receivers fail closed even when they use a familiar property spelling.
#[must_use]
pub fn classify_state_property_result(
    receiver: StateReceiverKind,
    property: &str,
) -> StateReceiverKind {
    match (receiver, property) {
        (
            StateReceiverKind::Array | StateReceiverKind::String | StateReceiverKind::TypedArray,
            "length",
        )
        | (StateReceiverKind::Map | StateReceiverKind::Set, "size") => StateReceiverKind::Number,
        _ => StateReceiverKind::Unknown,
    }
}

/// Whether a proven built-in method always returns a scalar value.
///
/// Scalar results cannot preserve the object identity of a shallow `$state` receiver or one of
/// its nested values. Methods such as `find`, `at`, `get`, and `reduce` are intentionally absent:
/// depending on their receiver or arguments, they can return a state-derived object. Unknown
/// receivers and protocol-dispatched string methods also fail closed.
#[must_use]
pub fn state_method_returns_scalar(receiver: StateReceiverKind, method: &str) -> bool {
    if classify_state_method_call(receiver, method) != StateMethodCallSemantics::ReadOnlyReceiver {
        return false;
    }
    match receiver {
        StateReceiverKind::Unknown => false,
        StateReceiverKind::Array => !matches!(
            method,
            "at" | "concat"
                | "entries"
                | "filter"
                | "find"
                | "findLast"
                | "flat"
                | "flatMap"
                | "keys"
                | "map"
                | "reduce"
                | "reduceRight"
                | "slice"
                | "toReversed"
                | "toSorted"
                | "toSpliced"
                | "valueOf"
                | "values"
                | "with"
        ),
        StateReceiverKind::DataView => method != "valueOf",
        StateReceiverKind::Date | StateReceiverKind::Number => true,
        StateReceiverKind::Function => !matches!(method, "apply" | "bind" | "call" | "valueOf"),
        StateReceiverKind::Map => {
            !matches!(method, "entries" | "get" | "keys" | "valueOf" | "values")
        }
        StateReceiverKind::Promise => !matches!(method, "catch" | "finally" | "then" | "valueOf"),
        StateReceiverKind::Set => !matches!(
            method,
            "difference"
                | "entries"
                | "intersection"
                | "keys"
                | "symmetricDifference"
                | "union"
                | "valueOf"
                | "values"
        ),
        StateReceiverKind::String => !matches!(
            method,
            "match" | "matchAll" | "replace" | "replaceAll" | "search" | "split"
        ),
        StateReceiverKind::TypedArray => !matches!(
            method,
            "entries"
                | "filter"
                | "keys"
                | "map"
                | "reduce"
                | "reduceRight"
                | "slice"
                | "subarray"
                | "toReversed"
                | "toSorted"
                | "valueOf"
                | "values"
                | "with"
        ),
        StateReceiverKind::WeakMap => !matches!(method, "get" | "valueOf"),
        StateReceiverKind::WeakSet => method != "valueOf",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        StateMethodCallSemantics, StateReceiverKind, classify_state_method_call,
        classify_state_method_result, classify_state_property_result, state_method_returns_scalar,
    };

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

    #[test]
    fn preserves_result_families_only_for_matching_builtin_receivers() {
        assert_eq!(
            classify_state_method_result(StateReceiverKind::Array, "map"),
            StateReceiverKind::Array
        );
        assert_eq!(
            classify_state_method_result(StateReceiverKind::TypedArray, "subarray"),
            StateReceiverKind::TypedArray
        );
        assert_eq!(
            classify_state_method_result(StateReceiverKind::Promise, "then"),
            StateReceiverKind::Promise
        );
        assert_eq!(
            classify_state_method_result(StateReceiverKind::Unknown, "map"),
            StateReceiverKind::Unknown
        );
        assert_eq!(
            classify_state_method_result(StateReceiverKind::Map, "map"),
            StateReceiverKind::Unknown
        );
    }

    #[test]
    fn identifies_only_results_that_cannot_carry_state_identity_as_scalars() {
        for (receiver, method) in [
            (StateReceiverKind::Array, "join"),
            (StateReceiverKind::Array, "findIndex"),
            (StateReceiverKind::DataView, "getUint8"),
            (StateReceiverKind::Date, "getTime"),
            (StateReceiverKind::Map, "has"),
            (StateReceiverKind::Set, "isSubsetOf"),
            (StateReceiverKind::String, "toUpperCase"),
            (StateReceiverKind::TypedArray, "find"),
            (StateReceiverKind::WeakMap, "has"),
        ] {
            assert!(
                state_method_returns_scalar(receiver, method),
                "{receiver:?}.{method}"
            );
        }

        for (receiver, method) in [
            (StateReceiverKind::Unknown, "join"),
            (StateReceiverKind::Array, "at"),
            (StateReceiverKind::Array, "find"),
            (StateReceiverKind::Array, "reduce"),
            (StateReceiverKind::Map, "get"),
            (StateReceiverKind::String, "match"),
            (StateReceiverKind::TypedArray, "reduce"),
        ] {
            assert!(
                !state_method_returns_scalar(receiver, method),
                "{receiver:?}.{method}"
            );
        }
    }

    #[test]
    fn classifies_scalar_properties_only_for_matching_builtin_receivers() {
        for (receiver, property) in [
            (StateReceiverKind::Array, "length"),
            (StateReceiverKind::String, "length"),
            (StateReceiverKind::TypedArray, "length"),
            (StateReceiverKind::Map, "size"),
            (StateReceiverKind::Set, "size"),
        ] {
            assert_eq!(
                classify_state_property_result(receiver, property),
                StateReceiverKind::Number,
                "{receiver:?}.{property}"
            );
        }
        assert_eq!(
            classify_state_property_result(StateReceiverKind::Unknown, "length"),
            StateReceiverKind::Unknown
        );
        assert_eq!(
            classify_state_property_result(StateReceiverKind::Array, "size"),
            StateReceiverKind::Unknown
        );
    }
}
