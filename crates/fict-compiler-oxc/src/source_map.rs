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
    if generated.sources.is_empty() {
        return Err("generated source map has no source to compose".to_owned());
    }
    if generated.sources.len() == 1 && input.file.is_none() {
        return Ok(0);
    }
    let input_file = input
        .file
        .as_deref()
        .ok_or_else(|| "source-map composition requires the input map file identity".to_owned())?;

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
    strip_module_suffix: bool,
) -> Vec<u32> {
    let input_file = normalized_source_identity(input_file, strip_module_suffix);
    generated
        .sources
        .iter()
        .enumerate()
        .filter(|(_, source)| {
            normalized_resolved_source_identity(
                generated.source_root.as_deref(),
                source,
                strip_module_suffix,
            ) == input_file
        })
        .filter_map(|(index, _)| u32::try_from(index).ok())
        .collect()
}

fn normalized_resolved_source_identity(
    root: Option<&str>,
    source: &str,
    strip_module_suffix: bool,
) -> String {
    let resolved = root.map_or_else(
        || source.to_owned(),
        |root| rooted_source_identity(root, source),
    );
    normalized_source_identity(&resolved, strip_module_suffix)
}

fn normalized_source_identity(identity: &str, strip_module_suffix: bool) -> String {
    let slashed = identity.replace('\\', "/");
    let identity = if strip_module_suffix {
        strip_source_module_suffix(&slashed)
    } else {
        slashed.as_str()
    };

    if let Some(scheme_separator) = hierarchical_scheme_separator(identity) {
        let scheme = identity[..scheme_separator].to_ascii_lowercase();
        let remainder = &identity[scheme_separator + 3..];
        let (authority, path) = remainder.find('/').map_or((remainder, ""), |index| {
            (&remainder[..index], &remainder[index..])
        });
        return format!("{scheme}://{authority}{}", normalize_path_segments(path));
    }
    if has_uri_scheme(identity)
        && let Some(scheme_separator) = identity.find(':')
    {
        let scheme = identity[..scheme_separator].to_ascii_lowercase();
        return format!("{scheme}{}", &identity[scheme_separator..]);
    }
    normalize_path_segments(identity)
}

fn strip_source_module_suffix(identity: &str) -> &str {
    let query = identity.find('?').unwrap_or(identity.len());
    let fragment = identity.find('#').unwrap_or(identity.len());
    let suffix_start = query.min(fragment);
    if suffix_start == identity.len() {
        return identity;
    }
    if has_uri_scheme(identity) {
        return &identity[..suffix_start];
    }
    // POSIX permits both delimiters in physical filenames, so stripping either one would make
    // distinct files share an identity. A `?` cannot occur in a Windows drive path; accept that
    // narrowly identifiable bundler form while keeping fragment-only paths literal.
    let windows_drive = identity.as_bytes().get(1) == Some(&b':');
    let physical_prefix = &identity[..query];
    if windows_drive
        && query < fragment
        && query < identity.len()
        && has_supported_source_extension(physical_prefix)
    {
        physical_prefix
    } else {
        identity
    }
}

fn has_supported_source_extension(identity: &str) -> bool {
    let lower = identity.to_ascii_lowercase();
    [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn hierarchical_scheme_separator(identity: &str) -> Option<usize> {
    let separator = identity.find("://")?;
    is_uri_scheme(&identity[..separator]).then_some(separator)
}

fn has_uri_scheme(identity: &str) -> bool {
    let Some(separator) = identity.find(':') else {
        return false;
    };
    if separator == 1
        && identity.as_bytes()[0].is_ascii_alphabetic()
        && !identity[separator + 1..].starts_with("//")
    {
        return false;
    }
    is_uri_scheme(&identity[..separator])
}

fn is_uri_scheme(candidate: &str) -> bool {
    candidate
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn normalize_path_segments(identity: &str) -> String {
    if identity.is_empty() {
        return String::new();
    }
    let drive =
        (identity.as_bytes().get(1) == Some(&b':')).then(|| identity[..2].to_ascii_uppercase());
    let rest = drive.as_ref().map_or(identity, |_| &identity[2..]);
    let leading_slashes = if rest.starts_with("//") {
        2
    } else if rest.starts_with('/') {
        1
    } else {
        0
    };
    let absolute = leading_slashes > 0;
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if !absolute => segments.push(segment),
            ".." => {}
            _ => segments.push(segment),
        }
    }
    let mut normalized = drive.unwrap_or_default();
    normalized.push_str(&"/".repeat(leading_slashes));
    normalized.push_str(&segments.join("/"));
    normalized
}

fn rooted_source_identity(root: &str, source: &str) -> String {
    let windows_drive =
        source.as_bytes().get(1) == Some(&b':') && source.as_bytes()[0].is_ascii_alphabetic();
    if source.starts_with('/')
        || source.starts_with("\\\\")
        || windows_drive
        || has_uri_scheme(source)
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

    use super::{
        compose_source_map_json, decode_payload, matching_source_ids, validate_source_map_json,
    };

    #[test]
    fn validates_and_composes_owned_json_payloads() {
        let generated = r#"{"version":3,"file":"out.js","sources":["intermediate.js"],"names":[],"mappings":"AAAA"}"#;
        let input = r#"{"version":3,"file":"intermediate.js","sources":["original.js"],"names":[],"mappings":"AAAA"}"#;

        assert_eq!(validate_source_map_json(generated), Ok(()));
        assert_eq!(validate_source_map_json(input), Ok(()));
        let composed = compose_source_map_json(generated, input).expect("composed source map");
        assert!(composed.contains("\"version\":3"));
        assert!(composed.contains("\"sources\":[\"original.js\"]"));
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

    #[test]
    fn rejects_a_mismatched_single_source_input_file() {
        let generated = r#"{"version":3,"file":"out.js","sources":["actual-intermediate.js"],"names":[],"mappings":"AAAA"}"#;
        let mismatched = r#"{"version":3,"file":"other-intermediate.js","sources":["original.js"],"names":[],"mappings":"AAAA"}"#;

        let error = compose_source_map_json(generated, mismatched)
            .expect_err("single-source composition must validate input.file");
        assert!(
            error.contains("does not identify a generated source"),
            "{error}"
        );
    }

    #[test]
    fn composes_a_single_source_input_without_a_file_identity() {
        let generated = r#"{"version":3,"file":"out.js","sources":["intermediate.js"],"names":[],"mappings":"AAAA"}"#;
        let input = r#"{"version":3,"sources":["original.ts"],"names":[],"mappings":"AAAA"}"#;

        let composed = compose_source_map_json(generated, input)
            .expect("a single generated source does not need disambiguation");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(composed.get_sources().collect::<Vec<_>>(), ["original.ts"]);
    }

    #[test]
    fn normalizes_source_root_dot_segments_and_hierarchical_uri_schemes() {
        let generated = r#"{"version":3,"file":"out.js","sourceRoot":"WEBPACK://project/src/./","sources":["./transforms/../intermediate.ts","virtual:helper.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let input = r#"{"version":3,"file":"webpack://project/src/intermediate.ts","sourceRoot":"webpack://project/authored/./nested/..","sources":["./original.tsx"],"names":[],"mappings":"AAAA"}"#;

        let composed =
            compose_source_map_json(generated, input).expect("URI identities should match");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            [
                "webpack://project/authored/original.tsx",
                "virtual:helper.js",
            ]
        );
    }

    #[test]
    fn preserves_windows_absolute_sources_outside_source_root() {
        let generated = r#"{"version":3,"file":"out.js","sources":["intermediate.ts","virtual:helper.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let input = r#"{"version":3,"file":"intermediate.ts","sourceRoot":"/authored","sources":["C:\\project\\original.tsx"],"names":[],"mappings":"AAAA"}"#;

        let composed =
            compose_source_map_json(generated, input).expect("Windows source should stay absolute");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            ["C:/project/original.tsx", "virtual:helper.js"]
        );
    }

    #[test]
    fn matches_opaque_scheme_sources_after_module_suffix_fallback() {
        let generated = r#"{"version":3,"file":"out.js","sources":["virtual:intermediate.ts?worker","virtual:helper.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let input = r#"{"version":3,"file":"virtual:intermediate.ts","sources":["original.tsx"],"names":[],"mappings":"AAAA"}"#;

        let composed =
            compose_source_map_json(generated, input).expect("opaque URI identity should match");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            ["original.tsx", "virtual:helper.js"]
        );
    }

    #[test]
    fn matches_opaque_uri_schemes_case_insensitively() {
        let generated = r#"{"version":3,"file":"out.js","sources":["VIRTUAL:intermediate.ts","virtual:helper.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let input = r#"{"version":3,"file":"virtual:intermediate.ts","sources":["original.tsx"],"names":[],"mappings":"AAAA"}"#;

        let composed = compose_source_map_json(generated, input)
            .expect("opaque URI scheme casing should not change source identity");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            ["original.tsx", "virtual:helper.js"]
        );
    }

    #[test]
    fn matches_single_character_hierarchical_uri_sources_after_suffix_fallback() {
        let generated = r#"{"version":3,"file":"out.js","sources":["x://project/intermediate.ts#worker","x://project/helper.js"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let input = r#"{"version":3,"file":"x://project/intermediate.ts","sources":["original.tsx"],"names":[],"mappings":"AAAA"}"#;

        let composed = compose_source_map_json(generated, input)
            .expect("single-character hierarchical URI identity should match");
        let composed = SourceMap::from_json_string(&composed).expect("decoded composed map");
        assert_eq!(
            composed.get_sources().collect::<Vec<_>>(),
            ["original.tsx", "x://project/helper.js"]
        );
    }

    #[test]
    fn suffix_fallback_does_not_collapse_literal_posix_source_filenames() {
        let generated = r#"{"version":3,"file":"out.js","sources":["/tmp/a.ts?worker","/tmp/a.ts#client"],"names":[],"mappings":"AAAA;ACAA"}"#;
        let payload = decode_payload(generated).expect("generated payload");
        assert!(matching_source_ids(&payload, "/tmp/a.ts", true).is_empty());

        let input = r#"{"version":3,"file":"/tmp/a.ts","sources":["/src/original.tsx"],"names":[],"mappings":"AAAA"}"#;
        let error = compose_source_map_json(generated, input)
            .expect_err("literal POSIX filenames must never match a stripped identity");
        assert!(
            error.contains("does not identify a generated source"),
            "{error}"
        );
    }
}
