use std::borrow::Cow;

pub(crate) fn normalize_source_bytes(bytes: &[u8]) -> Cow<'_, [u8]> {
    if !bytes.windows(2).any(|pair| pair == b"\r\n") {
        return Cow::Borrowed(bytes);
    }

    let mut normalized = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            normalized.push(b'\n');
            index += 2;
        } else {
            normalized.push(bytes[index]);
            index += 1;
        }
    }
    Cow::Owned(normalized)
}

#[cfg(test)]
mod tests {
    use super::normalize_source_bytes;

    #[test]
    fn normalizes_windows_line_endings_for_cross_platform_build_ids() {
        assert_eq!(
            normalize_source_bytes(b"Cargo.lock\r\ncrate source\r\n").as_ref(),
            b"Cargo.lock\ncrate source\n",
        );
    }

    #[test]
    fn preserves_lf_and_lone_carriage_returns() {
        let input = b"line one\nline two\rline three\n";
        assert_eq!(normalize_source_bytes(input).as_ref(), input);
    }
}
