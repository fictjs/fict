use fict_compiler::{
    AnalyzeRequest, AnalyzeResult, CompileRequest, CompileResult, ScanRequest, ScanResult,
    invalid_analyze_request_result, invalid_request_result, invalid_scan_request_result,
};
use napi::{
    Env, Error, JsValue, Property, Result, Status, ValueType,
    bindgen_prelude::{
        Array, JsObjectValue, KeyCollectionMode, KeyConversion, KeyFilter, Null, Object, Unknown,
    },
};
use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value};

use crate::incident::RequestFingerprint;

const MAX_NAPI_DECODE_DEPTH: u32 = 128;
const MAX_NAPI_DECODE_NODES: u64 = 1_000_000;
const MAX_NAPI_DECODE_STRING_BYTES: u64 = 256 * 1024 * 1024;

/// Work prepared on the JavaScript thread before async scheduling.
pub(crate) enum CompileWork {
    /// Valid owned request ready for the pure Rust pipeline.
    Request(Box<CompileRequest>),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(Box<CompileResult>),
}

/// Scan work prepared on the JavaScript thread before async scheduling.
pub(crate) enum ScanWork {
    /// Valid owned request ready for the pure Rust scanner.
    Request(ScanRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(ScanResult),
}

/// Analysis work prepared on the JavaScript thread before async scheduling.
pub(crate) enum AnalyzeWork {
    /// Valid owned request ready for the pure Rust tooling pipeline.
    Request(AnalyzeRequest),
    /// Structured malformed-input result; still resolves through the normal API.
    Immediate(AnalyzeResult),
}

pub(crate) fn decode_compile(env: &Env, value: Unknown<'_>) -> (CompileWork, RequestFingerprint) {
    match decode_request::<CompileRequest>(env, value) {
        Ok(request) => {
            let fingerprint = RequestFingerprint::compile(&request);
            (CompileWork::Request(Box::new(request)), fingerprint)
        }
        Err(error) => (
            CompileWork::Immediate(Box::new(invalid_request_result(format!(
                "request deserialization failed: {error}"
            )))),
            RequestFingerprint::default(),
        ),
    }
}

pub(crate) fn decode_scan(env: &Env, value: Unknown<'_>) -> (ScanWork, RequestFingerprint) {
    match decode_request::<ScanRequest>(env, value) {
        Ok(request) => {
            let fingerprint = RequestFingerprint::scan(&request);
            (ScanWork::Request(request), fingerprint)
        }
        Err(error) => (
            ScanWork::Immediate(invalid_scan_request_result(format!(
                "request deserialization failed: {error}"
            ))),
            RequestFingerprint::default(),
        ),
    }
}

pub(crate) fn decode_analyze(env: &Env, value: Unknown<'_>) -> (AnalyzeWork, RequestFingerprint) {
    match decode_request::<AnalyzeRequest>(env, value) {
        Ok(request) => {
            let fingerprint = RequestFingerprint::analyze(&request);
            (AnalyzeWork::Request(request), fingerprint)
        }
        Err(error) => (
            AnalyzeWork::Immediate(invalid_analyze_request_result(format!(
                "request deserialization failed: {error}"
            ))),
            RequestFingerprint::default(),
        ),
    }
}

#[cfg(test)]
pub(crate) fn prepare_compile(value: Value) -> CompileWork {
    match serde_json::from_value(value) {
        Ok(request) => CompileWork::Request(Box::new(request)),
        Err(error) => CompileWork::Immediate(Box::new(invalid_request_result(format!(
            "request deserialization failed: {error}"
        )))),
    }
}

#[cfg(test)]
pub(crate) fn prepare_scan(value: Value) -> ScanWork {
    match serde_json::from_value(value) {
        Ok(request) => ScanWork::Request(request),
        Err(error) => ScanWork::Immediate(invalid_scan_request_result(format!(
            "request deserialization failed: {error}"
        ))),
    }
}

#[cfg(test)]
pub(crate) fn prepare_analyze(value: Value) -> AnalyzeWork {
    match serde_json::from_value(value) {
        Ok(request) => AnalyzeWork::Request(request),
        Err(error) => AnalyzeWork::Immediate(invalid_analyze_request_result(format!(
            "request deserialization failed: {error}"
        ))),
    }
}

fn decode_request<T: DeserializeOwned>(env: &Env, value: Unknown<'_>) -> Result<T> {
    let mut state = DecodeState::default();
    let value = decode_json_value(env, value, &mut state, 0)?;
    serde_json::from_value(value).map_err(|error| Error::new(Status::InvalidArg, error.to_string()))
}

#[derive(Default)]
struct DecodeState<'env> {
    nodes: u64,
    string_bytes: u64,
    ancestors: Vec<Unknown<'env>>,
}

fn decode_json_value<'env>(
    env: &Env,
    value: Unknown<'env>,
    state: &mut DecodeState<'env>,
    depth: u32,
) -> Result<Value> {
    state.nodes = state.nodes.saturating_add(1);
    if state.nodes > MAX_NAPI_DECODE_NODES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("N-API request exceeds {MAX_NAPI_DECODE_NODES} JSON nodes"),
        ));
    }

    match value.get_type()? {
        ValueType::Object => decode_json_object(env, value, state, depth),
        ValueType::External | ValueType::Function | ValueType::Symbol => Err(Error::new(
            Status::InvalidArg,
            "N-API requests accept only JSON-compatible values".to_owned(),
        )),
        ValueType::Unknown => Err(Error::new(
            Status::InvalidArg,
            "N-API request contains a value with an unknown type".to_owned(),
        )),
        _ => {
            let decoded: Value = env.from_js_value(value)?;
            if let Value::String(string) = &decoded {
                add_string_bytes(state, string.len())?;
            }
            Ok(decoded)
        }
    }
}

fn decode_json_object<'env>(
    env: &Env,
    value: Unknown<'env>,
    state: &mut DecodeState<'env>,
    depth: u32,
) -> Result<Value> {
    if depth >= MAX_NAPI_DECODE_DEPTH {
        return Err(Error::new(
            Status::InvalidArg,
            format!("N-API request exceeds JSON nesting depth {MAX_NAPI_DECODE_DEPTH}"),
        ));
    }
    for ancestor in &state.ancestors {
        if env.strict_equals(*ancestor, value)? {
            return Err(Error::new(
                Status::InvalidArg,
                "N-API request contains a cyclic object graph".to_owned(),
            ));
        }
    }

    let object = value.coerce_to_object()?;
    if object.is_typedarray()?
        || object.is_dataview()?
        || object.is_buffer()?
        || object.is_arraybuffer()?
        || object.is_date()?
        || object.is_promise()?
        || object.is_error()?
    {
        return Err(Error::new(
            Status::InvalidArg,
            "N-API requests accept only plain objects and arrays".to_owned(),
        ));
    }

    state.ancestors.push(value);
    let result = if object.is_array()? {
        decode_json_array(env, &object, state, depth + 1)
    } else {
        decode_json_map(env, &object, state, depth + 1)
    };
    state.ancestors.pop();
    result
}

fn decode_json_array<'env>(
    env: &Env,
    object: &Object<'env>,
    state: &mut DecodeState<'env>,
    depth: u32,
) -> Result<Value> {
    let length = object.get_array_length()?;
    if state.nodes.saturating_add(u64::from(length)) > MAX_NAPI_DECODE_NODES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("N-API request exceeds {MAX_NAPI_DECODE_NODES} JSON nodes"),
        ));
    }
    let mut values = Vec::with_capacity(length as usize);
    for index in 0..length {
        values.push(decode_json_value(
            env,
            object.get_element::<Unknown<'env>>(index)?,
            state,
            depth,
        )?);
    }
    Ok(Value::Array(values))
}

fn decode_json_map<'env>(
    env: &Env,
    object: &Object<'env>,
    state: &mut DecodeState<'env>,
    depth: u32,
) -> Result<Value> {
    let names = object.get_all_property_names(
        KeyCollectionMode::OwnOnly,
        KeyFilter::Enumerable,
        KeyConversion::NumbersToStrings,
    )?;
    let length = names.get_array_length()?;
    if state.nodes.saturating_add(u64::from(length)) > MAX_NAPI_DECODE_NODES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("N-API request exceeds {MAX_NAPI_DECODE_NODES} JSON nodes"),
        ));
    }
    let mut values = Map::new();
    for index in 0..length {
        let key = names.get_element::<String>(index)?;
        add_string_bytes(state, key.len())?;
        let child = object.get_named_property::<Unknown<'env>>(&key)?;
        values.insert(key, decode_json_value(env, child, state, depth)?);
    }
    Ok(Value::Object(values))
}

fn add_string_bytes(state: &mut DecodeState<'_>, bytes: usize) -> Result<()> {
    state.string_bytes = state.string_bytes.saturating_add(bytes as u64);
    if state.string_bytes > MAX_NAPI_DECODE_STRING_BYTES {
        Err(Error::new(
            Status::InvalidArg,
            format!("N-API request exceeds {MAX_NAPI_DECODE_STRING_BYTES} decoded string bytes"),
        ))
    } else {
        Ok(())
    }
}

/// Define JSON map entries as own data properties so names such as `__proto__`
/// cannot invoke inherited setters while crossing the N-API boundary.
fn create_json_object(env: &Env, values: Map<String, Value>) -> Result<Object<'static>> {
    let mut object = Object::new(env)?;
    let properties = values
        .into_iter()
        .map(|(key, value)| create_json_property(env, &key, value))
        .collect::<Result<Vec<_>>>()?;
    object.define_properties(&properties)?;
    Ok(object)
}

fn create_json_array(env: &Env, values: Vec<Value>) -> Result<Array<'static>> {
    let mut array = Array::from_vec(env, Vec::<Null>::new())?;
    for (index, value) in values.into_iter().enumerate() {
        set_json_array_value(env, &mut array, index as u32, value)?;
    }
    Ok(array)
}

/// Convert JSON numbers explicitly so serde_json's `u64` N-API implementation
/// cannot silently change a protocol `number` into a JavaScript `bigint`.
fn javascript_number(value: &Number) -> Result<f64> {
    let maximum = fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER as f64;
    if let Some(value) = value.as_i64() {
        if value.unsigned_abs() > fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "native compiler result integer {value} exceeds the JavaScript safe-integer range"
                ),
            ));
        }
        return Ok(value as f64);
    }
    if let Some(value) = value.as_u64() {
        if value > fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "native compiler result integer {value} exceeds the JavaScript safe-integer range"
                ),
            ));
        }
        return Ok(value as f64);
    }
    let value = value.as_f64().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "native compiler result contains an unsupported JSON number".to_owned(),
        )
    })?;
    if value.fract() == 0.0 && value.abs() > maximum {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "native compiler result integer {value} exceeds the JavaScript safe-integer range"
            ),
        ));
    }
    Ok(value)
}

fn create_json_property(env: &Env, key: &str, value: Value) -> Result<Property> {
    let property = Property::new().with_utf8_name(key)?;
    match value {
        Value::Null => property.with_napi_value(env, Null),
        Value::Bool(value) => property.with_napi_value(env, value),
        Value::Number(value) => property.with_napi_value(env, javascript_number(&value)?),
        Value::String(value) => property.with_napi_value(env, value),
        Value::Array(values) => Ok(property.with_value(&create_json_array(env, values)?)),
        Value::Object(values) => Ok(property.with_value(&create_json_object(env, values)?)),
    }
}

fn set_json_array_value(
    env: &Env,
    array: &mut Array<'static>,
    index: u32,
    value: Value,
) -> Result<()> {
    match value {
        Value::Null => array.set(index, Null),
        Value::Bool(value) => array.set(index, value),
        Value::Number(value) => array.set(index, javascript_number(&value)?),
        Value::String(value) => array.set(index, value),
        Value::Array(values) => array.set(index, create_json_array(env, values)?),
        Value::Object(values) => array.set(index, create_json_object(env, values)?),
    }
}

fn serialize_json(env: &Env, value: Value, context: &str) -> Result<Object<'static>> {
    let Value::Object(values) = value else {
        return Err(Error::new(
            Status::GenericFailure,
            format!("native compiler {context} did not serialize to an object"),
        ));
    };
    create_json_object(env, values)
}

pub(crate) fn serialize_result(env: &Env, result: CompileResult) -> Result<Object<'static>> {
    let value = serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler result: {error}"),
        )
    })?;
    serialize_json(env, value, "result")
}

pub(crate) fn serialize_scan_result(env: &Env, result: ScanResult) -> Result<Object<'static>> {
    let value = serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler scan result: {error}"),
        )
    })?;
    serialize_json(env, value, "scan result")
}

pub(crate) fn serialize_analyze_result(
    env: &Env,
    result: AnalyzeResult,
) -> Result<Object<'static>> {
    let value = serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native compiler analysis result: {error}"),
        )
    })?;
    serialize_json(env, value, "analysis result")
}

pub(crate) fn serialize_parse_probe_result(
    env: &Env,
    result: crate::ParseProbeResult,
) -> Result<Object<'static>> {
    let value = serde_json::to_value(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("failed to serialize native parser probe result: {error}"),
        )
    })?;
    serialize_json(env, value, "parser probe result")
}

#[cfg(test)]
mod tests {
    use serde_json::{Number, json};

    use super::{
        AnalyzeWork, CompileWork, ScanWork, javascript_number, prepare_analyze, prepare_compile,
        prepare_scan,
    };

    #[test]
    fn converts_json_integers_to_javascript_safe_numbers() {
        let above_u32 = Number::from(u64::from(u32::MAX) + 1);
        assert_eq!(
            javascript_number(&above_u32).expect("safe u64"),
            4_294_967_296.0
        );

        let maximum = Number::from(fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER);
        assert_eq!(
            javascript_number(&maximum).expect("maximum safe u64"),
            fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER as f64
        );

        let overflow = Number::from(fict_compiler::MAX_SAFE_JAVASCRIPT_INTEGER + 1);
        assert!(javascript_number(&overflow).is_err());
        assert!(javascript_number(&Number::from(u64::MAX)).is_err());
    }

    #[test]
    fn malformed_requests_become_structured_results() {
        let work = prepare_compile(json!({ "code": 42, "filename": "module.ts" }));
        let CompileWork::Immediate(result) = work else {
            panic!("malformed request must not enter the compiler")
        };
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }

    #[test]
    fn malformed_scan_requests_become_structured_results() {
        let work = prepare_scan(json!({ "code": 42, "filename": "module.ts" }));
        let ScanWork::Immediate(result) = work else {
            panic!("malformed scan request must not enter the scanner")
        };
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }

    #[test]
    fn malformed_analyze_requests_become_structured_results() {
        let work = prepare_analyze(json!({ "code": 42, "filename": "module.ts" }));
        let AnalyzeWork::Immediate(result) = work else {
            panic!("malformed request must not enter the analyzer")
        };
        assert_eq!(result.diagnostics[0].code, "FICT-REQUEST");
    }
}
