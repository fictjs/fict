use oxc::syntax::xml_entities::XML_ENTITIES;

/// Decode the XML/HTML character references accepted inside JSX text and string attributes.
pub(crate) fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.char_indices();
    let mut copied_until = 0;
    while let Some((index, character)) = chars.next() {
        if character != '&' {
            continue;
        }
        let mut start = index;
        let mut end = None;
        for (candidate, character) in chars.by_ref() {
            if character == ';' {
                end = Some(candidate);
                break;
            }
            if character == '&' {
                start = candidate;
            }
        }
        let Some(end) = end else {
            break;
        };
        output.push_str(&input[copied_until..start]);
        copied_until = end + 1;
        let entity = &input[start + 1..end];
        let decoded = entity.strip_prefix('#').and_then(|number| {
            number.strip_prefix('x').map_or_else(
                || number.parse::<u32>().ok(),
                |hex| u32::from_str_radix(hex, 16).ok(),
            )
        });
        if let Some(character) = decoded.and_then(char::from_u32) {
            output.push(character);
        } else if let Some(character) = XML_ENTITIES.get(entity) {
            output.push(*character);
        } else {
            output.push('&');
            output.push_str(entity);
            output.push(';');
        }
    }
    output.push_str(&input[copied_until..]);
    output
}

/// Apply JSX's authored-text whitespace rules, then decode character references.
pub(crate) fn normalize_text(input: &str) -> Option<String> {
    let input = input.replace('\t', " ");
    if !input
        .chars()
        .any(|character| matches!(character, '\n' | '\r'))
    {
        return Some(decode_entities(&input));
    }

    let lines: Vec<_> = input.split(['\n', '\r']).collect();
    let last = lines.len().saturating_sub(1);
    let mut normalized = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        let line = match (index == 0, index == last) {
            (true, true) => line,
            (true, false) => line.trim_end_matches(' '),
            (false, true) => line.trim_start_matches(' '),
            (false, false) => line.trim_matches(' '),
        };
        if !line.is_empty() {
            normalized.push(decode_entities(line));
        }
    }
    (!normalized.is_empty()).then(|| normalized.join(" "))
}

#[cfg(test)]
mod tests {
    use super::{decode_entities, normalize_text};

    #[test]
    fn decodes_named_decimal_and_hex_entities_without_dropping_invalid_text() {
        assert_eq!(decode_entities("&amp;&#65;&#x42;&unknown;"), "&AB&unknown;");
    }

    #[test]
    fn applies_jsx_multiline_whitespace_rules() {
        assert_eq!(
            normalize_text("\n  hello &amp;\n  world\n"),
            Some("hello & world".into())
        );
        assert_eq!(normalize_text("\n  \n"), None);
        assert_eq!(normalize_text(" "), Some(" ".into()));
    }

    #[test]
    fn matches_standard_jsx_tab_and_unicode_whitespace_boundaries() {
        assert_eq!(normalize_text("a\tb"), Some("a b".into()));
        assert_eq!(
            normalize_text("\n\u{a0}keep\u{a0}\nnext\n"),
            Some("\u{a0}keep\u{a0} next".into())
        );
        assert_eq!(
            normalize_text("a\u{2028}b\u{2029}c"),
            Some("a\u{2028}b\u{2029}c".into())
        );
    }

    #[test]
    fn treats_crlf_and_lone_cr_as_authored_line_boundaries() {
        assert_eq!(
            normalize_text("\r\n  first\r  second\n"),
            Some("first second".into())
        );
    }
}
