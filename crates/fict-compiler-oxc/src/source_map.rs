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

struct CompositionSources {
    source_root: Option<String>,
    sources: Vec<String>,
    sources_content: Vec<Option<String>>,
    input_ids: Vec<u32>,
    generated_ids: Vec<Option<u32>>,
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
    let composed_source_id = composed_source_id(&generated_payload, &input_payload)?;
    let source_tables =
        composition_sources(&generated_payload, &input_payload, composed_source_id)?;
    let lookup = input_map.generate_lookup_table();
    let mut names = input_payload.names.clone();
    let mut tokens = Vec::with_capacity(generated_map.get_tokens().len());

    for generated_token in generated_map.get_tokens() {
        let generated_source_id = generated_token.get_source_id();
        if generated_source_id != Some(composed_source_id) {
            let source_id = generated_source_id
                .and_then(|id| source_tables.generated_ids.get(id as usize))
                .copied()
                .flatten();
            let name_id = match (
                source_id,
                generated_token
                    .get_name_id()
                    .and_then(|id| generated_map.get_name(id)),
            ) {
                (Some(_), Some(name)) => Some(intern_name(&mut names, name)?),
                _ => None,
            };
            tokens.push(Token::new(
                generated_token.get_dst_line(),
                generated_token.get_dst_col(),
                generated_token.get_src_line(),
                generated_token.get_src_col(),
                source_id,
                name_id,
            ));
            continue;
        }

        let traced = input_map.lookup_token_approx(
            &lookup,
            generated_token.get_src_line(),
            generated_token.get_src_col(),
        );
        let Some((traced, source_id)) = traced.and_then(|token| {
            let source_id = token.get_source_id()?;
            let source_id = source_tables.input_ids.get(source_id as usize).copied()?;
            Some((token, source_id))
        }) else {
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
            Some(source_id),
            name_id,
        ));
    }

    let mut composed = SourceMap::new(
        generated_payload.file.map(Cow::Owned),
        names.into_iter().map(Cow::Owned).collect(),
        source_tables.source_root.map(Cow::Owned),
        source_tables.sources.into_iter().map(Cow::Owned).collect(),
        source_tables
            .sources_content
            .into_iter()
            .map(|content| content.map(Cow::Owned))
            .collect(),
        tokens.into_boxed_slice(),
        None,
    );
    if !source_tables.ignore_list.is_empty() {
        composed.set_x_google_ignore_list(source_tables.ignore_list);
    }
    Ok(composed.to_json_string())
}

fn composition_sources(
    generated: &SourceMapPayload,
    input: &SourceMapPayload,
    composed_source_id: u32,
) -> Result<CompositionSources, String> {
    if generated.sources.len() == 1 {
        return Ok(CompositionSources {
            source_root: input.source_root.clone(),
            sources: input.sources.clone(),
            sources_content: input.sources_content.clone().unwrap_or_default(),
            input_ids: source_ids(input.sources.len())?,
            generated_ids: vec![None],
            ignore_list: input.ignore_list.clone(),
        });
    }

    let mut sources: Vec<_> = input
        .sources
        .iter()
        .map(|source| resolved_source_identity(input.source_root.as_deref(), source))
        .collect();
    let mut sources_content: Vec<_> = (0..input.sources.len())
        .map(|index| {
            input
                .sources_content
                .as_ref()
                .and_then(|contents| contents.get(index))
                .cloned()
                .flatten()
        })
        .collect();
    let input_ids = source_ids(input.sources.len())?;
    let mut generated_ids = vec![None; generated.sources.len()];
    for (index, source) in generated.sources.iter().enumerate() {
        let index = u32::try_from(index)
            .map_err(|_| "generated source-map source count exceeds u32".to_owned())?;
        if index == composed_source_id {
            continue;
        }
        let output_id = u32::try_from(sources.len())
            .map_err(|_| "composed source-map source count exceeds u32".to_owned())?;
        sources.push(resolved_source_identity(
            generated.source_root.as_deref(),
            source,
        ));
        sources_content.push(
            generated
                .sources_content
                .as_ref()
                .and_then(|contents| contents.get(index as usize))
                .cloned()
                .flatten(),
        );
        generated_ids[index as usize] = Some(output_id);
    }

    let mut ignore_list = input.ignore_list.clone();
    for &source_id in &generated.ignore_list {
        if let Some(output_id) = generated_ids.get(source_id as usize).copied().flatten() {
            ignore_list.push(output_id);
        }
    }
    ignore_list.sort_unstable();
    ignore_list.dedup();

    Ok(CompositionSources {
        source_root: None,
        sources,
        sources_content,
        input_ids,
        generated_ids,
        ignore_list,
    })
}

fn source_ids(count: usize) -> Result<Vec<u32>, String> {
    (0..count)
        .map(|index| {
            u32::try_from(index).map_err(|_| "source-map source count exceeds u32".to_owned())
        })
        .collect()
}

fn resolved_source_identity(root: Option<&str>, source: &str) -> String {
    let source = normalized_source_identity(source, false);
    root.map_or(source.clone(), |root| {
        normalized_source_identity(&rooted_source_identity(root, &source), false)
    })
}

fn composed_source_id(
    generated: &SourceMapPayload,
    input: &SourceMapPayload,
) -> Result<u32, String> {
    if generated.sources.len() == 1 {
        return Ok(0);
    }
    if generated.sources.is_empty() {
        return Err("generated source map has no source to compose".to_owned());
    }
    let input_file = input.file.as_deref().ok_or_else(|| {
        "multi-source composition requires the input map file identity".to_owned()
    })?;

    let exact = matching_source_ids(generated, input_file, false);
    let matches = if exact.is_empty() {
        matching_source_ids(generated, input_file, true)
    } else {
        exact
    };
    match matches.as_slice() {
        [source_id] => Ok(*source_id),
        [] => Err(format!(
            "input map file {input_file:?} does not identify a generated source"
        )),
        _ => Err(format!(
            "input map file {input_file:?} ambiguously identifies {} generated sources",
            matches.len()
        )),
    }
}

fn matching_source_ids(
    generated: &SourceMapPayload,
    input_file: &str,
    physical_only: bool,
) -> Vec<u32> {
    let input_file = normalized_source_identity(input_file, physical_only);
    generated
        .sources
        .iter()
        .enumerate()
        .filter(|(_, source)| {
            let source = normalized_source_identity(source, physical_only);
            if source == input_file {
                return true;
            }
            generated.source_root.as_deref().is_some_and(|root| {
                let rooted = rooted_source_identity(root, &source);
                normalized_source_identity(&rooted, physical_only) == input_file
            })
        })
        .filter_map(|(index, _)| u32::try_from(index).ok())
        .collect()
}

fn normalized_source_identity(identity: &str, physical_only: bool) -> String {
    let identity = identity.replace('\\', "/");
    if physical_only {
        let query = identity.find('?').unwrap_or(identity.len());
        let fragment = identity.find('#').unwrap_or(identity.len());
        identity[..query.min(fragment)].to_owned()
    } else {
        identity
    }
}

fn rooted_source_identity(root: &str, source: &str) -> String {
    if source.starts_with('/')
        || source.as_bytes().get(1) == Some(&b':')
        || source.contains("://")
        || source.starts_with("virtual:")
    {
        return source.to_owned();
    }
    format!("{}/{}", root.trim_end_matches(['/', '\\']), source)
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
    use oxc_sourcemap::{SourceMap, SourceMapBuilder};

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

    #[test]
    fn composes_only_the_identified_source_in_a_multi_source_map() {
        let mut generated = SourceMapBuilder::default();
        generated.set_file("bundle.js");
        let helper = generated.set_source_and_content("virtual:helper.js", "helper()");
        let authored = generated.set_source_and_content(
            "C:\\project\\intermediate.ts?worker#client",
            "const first = helper()\nconst second = helper()",
        );
        generated.add_token(0, 0, 0, 0, Some(authored), None);
        generated.add_token(1, 0, 0, 0, Some(helper), None);
        generated.add_token(2, 0, 1, 0, Some(authored), None);
        let mut generated_json: serde_json::Value =
            serde_json::from_str(&generated.into_sourcemap().to_json_string())
                .expect("generated source-map payload");
        generated_json["x_google_ignoreList"] = serde_json::json!([helper, authored]);

        let mut input = SourceMapBuilder::default();
        input.set_file("C:/project/intermediate.ts");
        let first = input.set_source_and_content("first.tsx", "const first = <First />");
        let second = input.set_source_and_content("second.tsx", "const second = <Second />");
        input.add_token(0, 0, 4, 6, Some(first), None);
        input.add_token(1, 0, 8, 2, Some(second), None);
        let mut input_json: serde_json::Value =
            serde_json::from_str(&input.into_sourcemap().to_json_string())
                .expect("input source-map payload");
        input_json["sourceRoot"] = serde_json::Value::String("/authored".to_owned());
        input_json["x_google_ignoreList"] = serde_json::json!([second]);

        let composed =
            compose_source_map_json(&generated_json.to_string(), &input_json.to_string())
                .expect("composed source map");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        let tokens: Vec<_> = composed.get_source_view_tokens().collect();

        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            [
                "/authored/first.tsx",
                "/authored/second.tsx",
                "virtual:helper.js",
            ]
        );
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0].get_source(), Some("/authored/first.tsx"));
        assert_eq!((tokens[0].get_src_line(), tokens[0].get_src_col()), (4, 6));
        assert_eq!(tokens[1].get_source(), Some("virtual:helper.js"));
        assert_eq!((tokens[1].get_src_line(), tokens[1].get_src_col()), (0, 0));
        assert_eq!(tokens[2].get_source(), Some("/authored/second.tsx"));
        assert_eq!((tokens[2].get_src_line(), tokens[2].get_src_col()), (8, 2));
        assert_eq!(composed.get_x_google_ignore_list(), Some(&[1, 2][..]));
    }

    #[test]
    fn rejects_unidentified_or_ambiguous_multi_source_composition() {
        let generated =
            r#"{"version":3,"sources":["first.js","second.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let missing_file =
            r#"{"version":3,"sources":["original.js"],"names":[],"mappings":"AAAA"}"#;
        let unknown_file = r#"{"version":3,"file":"unknown.js","sources":["original.js"],"names":[],"mappings":"AAAA"}"#;
        let ambiguous = r#"{"version":3,"file":"same.js","sources":["original.js"],"names":[],"mappings":"AAAA"}"#;
        let duplicate_generated =
            r#"{"version":3,"sources":["same.js","same.js"],"names":[],"mappings":"AAAA;ACAA"}"#;

        assert!(compose_source_map_json(generated, missing_file).is_err());
        assert!(compose_source_map_json(generated, unknown_file).is_err());
        assert!(compose_source_map_json(duplicate_generated, ambiguous).is_err());
    }
}
