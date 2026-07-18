/// One source coordinate using one-based lines and zero-based UTF-16 columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceLocation {
    /// One-based source line.
    pub line: u32,
    /// Zero-based UTF-16 column.
    pub column: u32,
}

#[derive(Debug, Clone, Copy)]
struct SourceLine {
    start: usize,
    end: usize,
}

/// ECMAScript-aware byte-offset index for diagnostics and tooling coordinates.
pub struct SourceIndex<'source> {
    source: &'source str,
    lines: Vec<SourceLine>,
}

impl<'source> SourceIndex<'source> {
    /// Index CRLF, CR, LF, line separator, and paragraph separator terminators.
    #[must_use]
    pub fn new(source: &'source str) -> Self {
        let bytes = source.as_bytes();
        let mut lines = Vec::new();
        let mut start = 0_usize;
        let mut index = 0_usize;
        while index < bytes.len() {
            if let Some(length) = line_terminator_len(bytes, index) {
                lines.push(SourceLine { start, end: index });
                index = index.saturating_add(length);
                start = index;
            } else {
                index += 1;
            }
        }
        lines.push(SourceLine {
            start,
            end: source.len(),
        });
        Self { source, lines }
    }

    /// Return the indexed source text.
    #[must_use]
    pub const fn source(&self) -> &'source str {
        self.source
    }

    /// Iterate source lines without their line terminators.
    pub fn lines(&self) -> impl Iterator<Item = &'source str> + '_ {
        self.lines
            .iter()
            .map(|line| &self.source[line.start..line.end])
    }

    /// Return the one-based line containing a UTF-8 byte offset.
    #[must_use]
    pub fn line_of(&self, byte_offset: u32) -> u32 {
        let offset = usize::try_from(byte_offset)
            .unwrap_or(usize::MAX)
            .min(self.source.len());
        let line_index = self
            .lines
            .partition_point(|line| line.start <= offset)
            .saturating_sub(1);
        count_u32(line_index.saturating_add(1))
    }

    /// Return the one-based line and zero-based UTF-16 column for a byte offset.
    #[must_use]
    pub fn location(&self, byte_offset: u32) -> SourceLocation {
        let mut offset = usize::try_from(byte_offset)
            .unwrap_or(usize::MAX)
            .min(self.source.len());
        while offset > 0 && !self.source.is_char_boundary(offset) {
            offset -= 1;
        }
        let line_index = self
            .lines
            .partition_point(|line| line.start <= offset)
            .saturating_sub(1);
        let line = self.lines[line_index];
        let column_end = offset.min(line.end);
        SourceLocation {
            line: count_u32(line_index.saturating_add(1)),
            column: count_u32(self.source[line.start..column_end].encode_utf16().count()),
        }
    }
}

fn line_terminator_len(bytes: &[u8], index: usize) -> Option<usize> {
    match bytes.get(index)? {
        b'\r' => Some(if bytes.get(index + 1) == Some(&b'\n') {
            2
        } else {
            1
        }),
        b'\n' => Some(1),
        0xe2 if bytes.get(index + 1) == Some(&0x80)
            && matches!(bytes.get(index + 2), Some(0xa8 | 0xa9)) =>
        {
            Some(3)
        }
        _ => None,
    }
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{SourceIndex, SourceLocation};

    #[test]
    fn indexes_every_ecmascript_terminator_and_utf16_column() {
        let source = "a\r\nb\rc\n😀\u{2028}e\u{2029}f";
        let index = SourceIndex::new(source);
        assert_eq!(
            index.lines().collect::<Vec<_>>(),
            ["a", "b", "c", "😀", "e", "f"]
        );

        for (needle, line) in [('a', 1), ('b', 2), ('c', 3), ('😀', 4), ('e', 5), ('f', 6)] {
            let offset = u32::try_from(source.find(needle).expect("character")).expect("offset");
            assert_eq!(index.location(offset), SourceLocation { line, column: 0 });
            assert_eq!(index.line_of(offset), line);
        }

        let emoji_end =
            u32::try_from(source.find('😀').expect("emoji") + '😀'.len_utf8()).expect("offset");
        assert_eq!(
            index.location(emoji_end),
            SourceLocation { line: 4, column: 2 }
        );
    }

    #[test]
    fn clamps_offsets_and_terminator_columns_to_valid_source_coordinates() {
        let source = "😀\r\nnext\n";
        let index = SourceIndex::new(source);
        assert_eq!(index.location(1), SourceLocation { line: 1, column: 0 });
        assert_eq!(index.location(4), SourceLocation { line: 1, column: 2 });
        assert_eq!(index.location(5), SourceLocation { line: 1, column: 2 });
        assert_eq!(
            index.location(u32::MAX),
            SourceLocation { line: 3, column: 0 }
        );
    }
}
