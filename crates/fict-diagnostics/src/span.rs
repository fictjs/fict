use serde::{Deserialize, Deserializer, Serialize, de};

/// Half-open UTF-8 byte range in the current compilation source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    /// Inclusive byte offset.
    start: u32,
    /// Exclusive byte offset.
    end: u32,
}

impl SourceSpan {
    /// Construct a valid half-open span, returning `None` for an inverted range.
    #[must_use]
    pub const fn new(start: u32, end: u32) -> Option<Self> {
        if start <= end {
            Some(Self { start, end })
        } else {
            None
        }
    }

    /// Construct an empty span at one byte offset.
    #[must_use]
    pub const fn empty(offset: u32) -> Self {
        Self {
            start: offset,
            end: offset,
        }
    }

    /// Return the inclusive byte offset.
    #[must_use]
    pub const fn start(self) -> u32 {
        self.start
    }

    /// Return the exclusive byte offset.
    #[must_use]
    pub const fn end(self) -> u32 {
        self.end
    }

    /// Return the byte length of the span.
    #[must_use]
    pub const fn len(self) -> u32 {
        self.end - self.start
    }

    /// Return whether the span contains no bytes.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }
}

impl<'de> Deserialize<'de> for SourceSpan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawSourceSpan {
            start: u32,
            end: u32,
        }

        let raw = RawSourceSpan::deserialize(deserializer)?;
        Self::new(raw.start, raw.end).ok_or_else(|| de::Error::custom("source span is inverted"))
    }
}

#[cfg(test)]
mod tests {
    use super::SourceSpan;

    #[test]
    fn validates_half_open_ranges() {
        let span = SourceSpan::new(3, 8).expect("valid span");
        assert_eq!(span.len(), 5);
        assert_eq!((span.start(), span.end()), (3, 8));
        assert!(!span.is_empty());
        assert!(SourceSpan::new(8, 3).is_none());
        assert!(SourceSpan::empty(5).is_empty());
    }
}
