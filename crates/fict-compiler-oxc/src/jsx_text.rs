use fict_hir::JavaScriptString;
use oxc::syntax::xml_entities::XML_ENTITIES;
use std::ops::Range;

/// Locate numeric JSX character references that exceed Unicode's maximum code point.
pub(crate) fn invalid_numeric_entity_ranges(input: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut chars = input.char_indices();
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
        let entity = &input[start + 1..end];
        if numeric_entity_exceeds_unicode(entity) {
            ranges.push(start..end + 1);
        }
    }
    ranges
}

fn numeric_entity_exceeds_unicode(entity: &str) -> bool {
    let (digits, maximum, radix) = if let Some(digits) = entity.strip_prefix("#x") {
        (digits, "10ffff", 16)
    } else if let Some(digits) = entity.strip_prefix('#') {
        (digits, "1114111", 10)
    } else {
        return false;
    };
    if digits.is_empty()
        || !digits.bytes().all(|digit| match radix {
            16 => digit.is_ascii_hexdigit(),
            _ => digit.is_ascii_digit(),
        })
    {
        return false;
    }
    let digits = digits.trim_start_matches('0');
    digits.len() > maximum.len()
        || digits.len() == maximum.len()
            && digits
                .bytes()
                .map(|digit| digit.to_ascii_lowercase())
                .gt(maximum.bytes())
}

/// Decode the XML/HTML character references accepted inside JSX text and string attributes.
pub(crate) fn decode_entities(input: &str) -> JavaScriptString {
    let mut output = JavaScriptString::default();
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
        if let Some(value) = decoded.filter(|value| *value <= 0x10_ffff) {
            if let Ok(value) = u16::try_from(value) {
                // JavaScript strings can represent lone surrogate code units even though Rust
                // `char` and `String` cannot.
                output.push_code_unit(value);
            } else if let Some(character) = char::from_u32(value) {
                output.push(character);
            }
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

/// Decode character references, then apply JSX's authored-text whitespace rules.
pub(crate) fn normalize_text(input: &str) -> Option<JavaScriptString> {
    let decoded = decode_entities(input);
    let mut input = decoded.as_code_units().to_vec();
    for code_unit in &mut input {
        if *code_unit == u16::from(b'\t') {
            *code_unit = u16::from(b' ');
        }
    }
    if !input
        .iter()
        .any(|code_unit| matches!(*code_unit, 0x0a | 0x0d))
    {
        return Some(JavaScriptString::from_code_units(input));
    }

    let lines: Vec<_> = input
        .split(|code_unit| matches!(*code_unit, 0x0a | 0x0d))
        .collect();
    let last = lines.len().saturating_sub(1);
    let mut normalized = JavaScriptString::default();
    let mut has_line = false;
    for (index, line) in lines.into_iter().enumerate() {
        let line = match (index == 0, index == last) {
            (true, true) => line,
            (true, false) => line.trim_ascii_end(),
            (false, true) => line.trim_ascii_start(),
            (false, false) => line.trim_ascii(),
        };
        if line.is_empty() {
            continue;
        }
        if has_line {
            normalized.push(' ');
        }
        for code_unit in line {
            normalized.push_code_unit(*code_unit);
        }
        has_line = true;
    }
    has_line.then_some(normalized)
}

trait TrimAsciiSpace {
    fn trim_ascii_start(&self) -> &Self;
    fn trim_ascii_end(&self) -> &Self;
    fn trim_ascii(&self) -> &Self;
}

impl TrimAsciiSpace for [u16] {
    fn trim_ascii_start(&self) -> &Self {
        let start = self
            .iter()
            .position(|code_unit| *code_unit != u16::from(b' '))
            .unwrap_or(self.len());
        &self[start..]
    }

    fn trim_ascii_end(&self) -> &Self {
        let end = self
            .iter()
            .rposition(|code_unit| *code_unit != u16::from(b' '))
            .map_or(0, |index| index + 1);
        &self[..end]
    }

    fn trim_ascii(&self) -> &Self {
        self.trim_ascii_start().trim_ascii_end()
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_entities, invalid_numeric_entity_ranges, normalize_text};
    use fict_hir::JavaScriptString;

    #[test]
    fn decodes_named_decimal_and_hex_entities_without_dropping_invalid_text() {
        assert_eq!(
            decode_entities("&amp;&#65;&#x42;&unknown;"),
            JavaScriptString::from("&AB&unknown;")
        );
        assert_eq!(
            decode_entities("&#x110000;"),
            JavaScriptString::from("&#x110000;")
        );
    }

    #[test]
    fn preserves_exact_utf16_numeric_entities() {
        assert_eq!(
            decode_entities("&#xD800;&#55296;&#x1F600;"),
            JavaScriptString::from_code_units(vec![0xd800, 0xd800, 0xd83d, 0xde00])
        );
    }

    #[test]
    fn identifies_only_complete_out_of_range_numeric_entities() {
        assert_eq!(
            invalid_numeric_entity_ranges("a&#1114112;b&#x10FFFF;c&#x110000;d"),
            vec![1..11, 23..33]
        );
        assert_eq!(
            invalid_numeric_entity_ranges(
                "&#0001114112;&#x00110000;&#9999999999999999999999999999999999999999;"
            ),
            vec![0..13, 13..25, 25..68]
        );
        for valid in [
            "&#1114111;",
            "&#x10FFFF;",
            "&#xD800;",
            "&#x;",
            "&#;",
            "&#-1;",
            "&#X110000;",
            "&#1114112x;",
            "&#x110000z;",
        ] {
            assert!(invalid_numeric_entity_ranges(valid).is_empty(), "{valid}");
        }
    }

    #[test]
    fn applies_jsx_multiline_whitespace_rules() {
        assert_eq!(
            normalize_text("\n  hello &amp;\n  world\n"),
            Some(JavaScriptString::from("hello & world"))
        );
        assert_eq!(normalize_text("\n  \n"), None);
        assert_eq!(normalize_text(" "), Some(JavaScriptString::from(" ")));
    }

    #[test]
    fn matches_standard_jsx_tab_and_unicode_whitespace_boundaries() {
        assert_eq!(normalize_text("a\tb"), Some(JavaScriptString::from("a b")));
        assert_eq!(
            normalize_text("\n\u{a0}keep\u{a0}\nnext\n"),
            Some(JavaScriptString::from("\u{a0}keep\u{a0} next"))
        );
        assert_eq!(
            normalize_text("a\u{2028}b\u{2029}c"),
            Some(JavaScriptString::from("a\u{2028}b\u{2029}c"))
        );
    }

    #[test]
    fn decodes_entities_before_applying_whitespace_rules() {
        assert_eq!(
            normalize_text("a&#9;b"),
            Some(JavaScriptString::from("a b"))
        );
        assert_eq!(
            normalize_text("a&#10;  b"),
            Some(JavaScriptString::from("a b"))
        );
        assert_eq!(
            normalize_text("a&#13;  b"),
            Some(JavaScriptString::from("a b"))
        );
        assert_eq!(
            normalize_text("a\n&#32;&#32;b\n"),
            Some(JavaScriptString::from("a b"))
        );
        assert_eq!(
            normalize_text("\n &#xD800; \n"),
            Some(JavaScriptString::from_code_units(vec![0xd800]))
        );
    }

    #[test]
    fn treats_crlf_and_lone_cr_as_authored_line_boundaries() {
        assert_eq!(
            normalize_text("\r\n  first\r  second\n"),
            Some(JavaScriptString::from("first second"))
        );
    }
}
