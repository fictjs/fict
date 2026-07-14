use std::borrow::Cow;

use oxc_sourcemap::{SourceMap, Token};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceMapPayload {
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_root: Option<String>,
    sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sources_content: Option<Vec<Option<String>>>,
    #[serde(default)]
    names: Vec<String>,
    mappings: String,
    #[serde(
        default,
        rename = "x_google_ignoreList",
        skip_serializing_if = "Vec::is_empty"
    )]
    ignore_list: Vec<u32>,
}

/// Validate encoded source-map mappings without exposing an OXC type to the
/// compiler orchestrator.
pub fn validate_source_map_json(source_map_json: &str) -> Result<(), String> {
    decode_source_map(source_map_json).map(drop)
}

/// Compose a generated source map through an input map and return an owned
/// Source Map v3 JSON payload.
pub fn compose_source_map_json(generated_json: &str, input_json: &str) -> Result<String, String> {
    let generated_payload = decode_payload(generated_json)?;
    let input_payload = decode_payload(input_json)?;
    let generated_map = decode_source_map(generated_json)?;
    let input_map = decode_source_map(input_json)?;
    let lookup = input_map.generate_lookup_table();
    let mut names = input_payload.names.clone();
    let mut tokens = Vec::with_capacity(generated_map.get_tokens().len());

    for generated_token in generated_map.get_tokens() {
        let traced = generated_token.get_source_id().and_then(|_| {
            input_map.lookup_token_approx(
                &lookup,
                generated_token.get_src_line(),
                generated_token.get_src_col(),
            )
        });
        let Some(traced) = traced.filter(|token| token.get_source_id().is_some()) else {
            tokens.push(Token::new(
                generated_token.get_dst_line(),
                generated_token.get_dst_col(),
                0,
                0,
                None,
                None,
            ));
            continue;
        };

        let name_id = if let Some(name_id) = traced.get_name_id() {
            Some(name_id)
        } else if let Some(name) = generated_token
            .get_name_id()
            .and_then(|id| generated_map.get_name(id))
        {
            Some(intern_name(&mut names, name)?)
        } else {
            None
        };
        tokens.push(Token::new(
            generated_token.get_dst_line(),
            generated_token.get_dst_col(),
            traced.get_src_line(),
            traced.get_src_col(),
            traced.get_source_id(),
            name_id,
        ));
    }

    let mut composed = SourceMap::new(
        generated_payload.file.map(Cow::Owned),
        names.into_iter().map(Cow::Owned).collect(),
        input_payload.source_root.map(Cow::Owned),
        input_payload.sources.into_iter().map(Cow::Owned).collect(),
        input_payload
            .sources_content
            .unwrap_or_default()
            .into_iter()
            .map(|content| content.map(Cow::Owned))
            .collect(),
        tokens.into_boxed_slice(),
        None,
    );
    if !input_payload.ignore_list.is_empty() {
        composed.set_x_google_ignore_list(input_payload.ignore_list);
    }
    Ok(composed.to_json_string())
}

fn decode_payload(source_map_json: &str) -> Result<SourceMapPayload, String> {
    serde_json::from_str(source_map_json)
        .map_err(|error| format!("cannot decode source map payload: {error}"))
}

fn decode_source_map(source_map_json: &str) -> Result<SourceMap<'static>, String> {
    SourceMap::from_json_string(source_map_json)
        .map(SourceMap::into_owned)
        .map_err(|error| format!("invalid source-map mappings: {error}"))
}

fn intern_name(names: &mut Vec<String>, name: &str) -> Result<u32, String> {
    if let Some(index) = names.iter().position(|existing| existing == name) {
        return u32::try_from(index).map_err(|_| "source-map name count exceeds u32".to_owned());
    }
    let index =
        u32::try_from(names.len()).map_err(|_| "source-map name count exceeds u32".to_owned())?;
    names.push(name.to_owned());
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::{compose_source_map_json, validate_source_map_json};

    #[test]
    fn validates_and_composes_owned_json_payloads() {
        let map =
            r#"{"version":3,"file":"out.js","sources":["in.js"],"names":[],"mappings":"AAAA"}"#;

        assert_eq!(validate_source_map_json(map), Ok(()));
        let composed = compose_source_map_json(map, map).expect("composed source map");
        assert!(composed.contains("\"version\":3"));
        assert!(composed.contains("\"sources\":[\"in.js\"]"));
    }

    #[test]
    fn rejects_invalid_mappings_without_leaking_oxc_errors_as_types() {
        let invalid = r#"{"version":3,"sources":["in.js"],"names":[],"mappings":"!"}"#;

        assert!(validate_source_map_json(invalid).is_err());
    }
}
