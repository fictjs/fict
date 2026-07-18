use std::collections::BTreeSet;

use fict_diagnostics::SourceSpan;
use fict_hir::ScopeId;
use oxc::{
    ast::{
        Comment,
        ast::{
            ArrowFunctionExpression, CommentContent, Directive, Function, NewExpression, Program,
        },
    },
    ast_visit::{
        Visit,
        walk::{
            walk_arrow_function_expression, walk_call_expression, walk_function,
            walk_new_expression, walk_program,
        },
    },
    syntax::scope::ScopeFlags,
};

use crate::frontend::scope_id;

/// Fict or JavaScript directive category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FictDirectiveKind {
    /// Standard JavaScript strict-mode directive.
    UseStrict,
    /// Enable Fict compilation for a scope.
    UseFictCompiler,
    /// Disable Fict compilation for a scope.
    DisableFictCompiler,
    /// Disable memo optimization for a scope.
    NoMemo,
    /// License pure-function optimization rules for a scope.
    Pure,
    /// Unrecognized directive that must still be preserved by emission.
    Other,
}

/// Formal directive prologue entry owned by one semantic scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendDirective {
    /// Semantic scope containing the directive prologue.
    pub scope: ScopeId,
    /// Recognized category.
    pub kind: FictDirectiveKind,
    /// Decoded directive value.
    pub value: String,
    /// Full directive statement span.
    pub span: SourceSpan,
}

/// Scope of a diagnostic suppression comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SuppressionMode {
    /// Suppress matching diagnostics on the directive's own line.
    SameLine,
    /// Suppress matching diagnostics on the line after the complete comment.
    NextLine,
}

/// Parsed `fict-ignore` suppression comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendSuppression {
    /// Same-line or next-line behavior.
    pub mode: SuppressionMode,
    /// One-based target line.
    pub target_line: u32,
    /// Diagnostic code/family patterns. Empty means all diagnostics on the target line.
    pub codes: Vec<String>,
    /// Full source comment span.
    pub comment_span: SourceSpan,
}

/// AST host to which a pure/no-side-effects annotation was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PureTargetKind {
    /// Call expression annotated with `@__PURE__` or `#__PURE__`.
    Call,
    /// Constructor expression annotated as pure.
    New,
    /// Function or arrow annotated with `#__NO_SIDE_EFFECTS__`.
    Function,
}

/// Applied pure/no-side-effects annotation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PureAnnotation {
    /// Annotated AST host category.
    pub target_kind: PureTargetKind,
    /// Full host expression/declaration span.
    pub target_span: SourceSpan,
    /// Annotation comment span when OXC attached one at the host start.
    pub comment_span: Option<SourceSpan>,
}

/// Parsed special comment category related to purity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PureCommentKind {
    /// Applied pure call/new annotation.
    Pure,
    /// Pure annotation that OXC could not apply to a supported host.
    PureNotApplied,
    /// Function no-side-effects annotation.
    NoSideEffects,
}

/// Pure-related source comment retained independently from AST application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PureComment {
    /// Parsed comment category.
    pub kind: PureCommentKind,
    /// Full comment span.
    pub span: SourceSpan,
    /// Byte offset of the token to which OXC attached the comment.
    pub attached_to: u32,
}

/// Reactive value category accepted by `@fictReturn`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveValueKind {
    /// Signal/accessor value.
    Signal,
    /// Memo/accessor value.
    Memo,
    /// Store value.
    Store,
}

/// Parsed `@fictReturn` payload shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FictReturnShape {
    /// Direct accessor return.
    Direct(ReactiveValueKind),
    /// Object properties in annotation order.
    Object(Vec<(String, ReactiveValueKind)>),
    /// Array indices in annotation order.
    Array(Vec<(u32, ReactiveValueKind)>),
}

/// One attached `@fictReturn` annotation, including invalid payloads for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFictReturn {
    /// Full JSDoc comment span.
    pub comment_span: SourceSpan,
    /// Byte offset of the declaration token to which OXC attached the JSDoc.
    pub attached_to: u32,
    /// Extracted balanced or single-line payload.
    pub payload: String,
    /// Parsed supported shape; absent when the payload is malformed or unsupported.
    pub shape: Option<FictReturnShape>,
}

/// All source facts that must survive the OXC arena boundary.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FrontendSourceFacts {
    /// Formal directive prologues in source order.
    pub directives: Vec<FrontendDirective>,
    /// Exact suppression comments in source order.
    pub suppressions: Vec<FrontendSuppression>,
    /// Applied pure/no-side-effects annotations in target source order.
    pub pure_annotations: Vec<PureAnnotation>,
    /// All special pure-related comments, including unapplied comments.
    pub pure_comments: Vec<PureComment>,
    /// Attached `@fictReturn` JSDoc annotations in source order.
    pub fict_returns: Vec<ParsedFictReturn>,
}

pub(super) fn collect_source_facts(source: &str, program: &Program<'_>) -> FrontendSourceFacts {
    let line_index = SourceLineIndex::new(source);
    let mut facts = FrontendSourceFacts::default();

    for comment in &program.comments {
        let span = source_span(comment.span);
        if let Some(kind) = match comment.content {
            CommentContent::Pure => Some(PureCommentKind::Pure),
            CommentContent::PureNotApplied => Some(PureCommentKind::PureNotApplied),
            CommentContent::NoSideEffects => Some(PureCommentKind::NoSideEffects),
            _ => None,
        } {
            facts.pure_comments.push(PureComment {
                kind,
                span,
                attached_to: comment.attached_to,
            });
        }

        if let Some(suppression) = parse_suppression(source, *comment, &line_index) {
            facts.suppressions.push(suppression);
        }

        if comment.is_leading()
            && matches!(
                comment.content,
                CommentContent::Jsdoc | CommentContent::JsdocLegal
            )
            && let Some(parsed) = parse_fict_return(source, *comment)
        {
            facts.fict_returns.push(parsed);
        }
    }

    let mut collector = AstFactCollector::default();
    collector.visit_program(program);
    facts.directives = collector.directives;
    facts.pure_annotations = collector.pure_annotations;
    for annotation in &mut facts.pure_annotations {
        annotation.comment_span = facts
            .pure_comments
            .iter()
            .rev()
            .find(|comment| {
                comment.attached_to == annotation.target_span.start()
                    && matches!(
                        (comment.kind, annotation.target_kind),
                        (
                            PureCommentKind::Pure,
                            PureTargetKind::Call | PureTargetKind::New
                        ) | (PureCommentKind::NoSideEffects, PureTargetKind::Function)
                    )
            })
            .map(|comment| comment.span);
    }

    facts
        .directives
        .sort_by_key(|directive| (directive.span.start(), directive.scope));
    facts
        .suppressions
        .sort_by_key(|suppression| suppression.comment_span.start());
    facts
        .pure_annotations
        .sort_by_key(|annotation| annotation.target_span.start());
    facts
        .pure_comments
        .sort_by_key(|comment| comment.span.start());
    facts
        .fict_returns
        .sort_by_key(|annotation| annotation.comment_span.start());
    facts
}

#[derive(Default)]
struct AstFactCollector {
    directives: Vec<FrontendDirective>,
    pure_annotations: Vec<PureAnnotation>,
}

impl AstFactCollector {
    fn add_directives(&mut self, scope: ScopeId, directives: &[Directive<'_>]) {
        self.directives.extend(directives.iter().map(|directive| {
            let value = directive.expression.value.to_string();
            FrontendDirective {
                scope,
                kind: directive_kind(&value),
                value,
                span: source_span(directive.span),
            }
        }));
    }

    fn add_pure_target(&mut self, target_kind: PureTargetKind, span: oxc::span::Span) {
        self.pure_annotations.push(PureAnnotation {
            target_kind,
            target_span: source_span(span),
            comment_span: None,
        });
    }
}

impl<'a> Visit<'a> for AstFactCollector {
    fn visit_program(&mut self, program: &Program<'a>) {
        if let Some(scope) = program.scope_id.get() {
            self.add_directives(scope_id(scope.index()), &program.directives);
        }
        walk_program(self, program);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let (Some(scope), Some(body)) = (function.scope_id.get(), &function.body) {
            self.add_directives(scope_id(scope.index()), &body.directives);
        }
        if function.pure {
            self.add_pure_target(PureTargetKind::Function, function.span);
        }
        walk_function(self, function, flags);
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        if let Some(scope) = function.scope_id.get() {
            self.add_directives(scope_id(scope.index()), &function.body.directives);
        }
        if function.pure {
            self.add_pure_target(PureTargetKind::Function, function.span);
        }
        walk_arrow_function_expression(self, function);
    }

    fn visit_call_expression(&mut self, call: &oxc::ast::ast::CallExpression<'a>) {
        if call.pure {
            self.add_pure_target(PureTargetKind::Call, call.span);
        }
        walk_call_expression(self, call);
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        if expression.pure {
            self.add_pure_target(PureTargetKind::New, expression.span);
        }
        walk_new_expression(self, expression);
    }
}

fn directive_kind(value: &str) -> FictDirectiveKind {
    match value {
        "use strict" => FictDirectiveKind::UseStrict,
        "use fict-compiler" => FictDirectiveKind::UseFictCompiler,
        "use fict-compiler-disable" => FictDirectiveKind::DisableFictCompiler,
        "use no memo" => FictDirectiveKind::NoMemo,
        "use pure" => FictDirectiveKind::Pure,
        _ => FictDirectiveKind::Other,
    }
}

fn parse_suppression(
    source: &str,
    comment: Comment,
    line_index: &SourceLineIndex,
) -> Option<FrontendSuppression> {
    let content_span = comment.content_span();
    let content = source.get(content_span.start as usize..content_span.end as usize)?;
    let comment_start_line = line_index.line_of(comment.span.start);
    let comment_end_line = line_index.line_of(comment.span.end.saturating_sub(1));

    for (line_offset, line) in source_lines(content).into_iter().enumerate() {
        let normalized = line.trim().strip_prefix('*').unwrap_or(line.trim()).trim();
        let Some((mode, raw_codes)) = suppression_directive(normalized) else {
            continue;
        };
        let target_line = match mode {
            SuppressionMode::SameLine => comment_start_line.saturating_add(count_u32(line_offset)),
            SuppressionMode::NextLine => comment_end_line.saturating_add(1),
        };
        return Some(FrontendSuppression {
            mode,
            target_line,
            codes: parse_suppression_codes(raw_codes),
            comment_span: source_span(comment.span),
        });
    }
    None
}

fn suppression_directive(line: &str) -> Option<(SuppressionMode, &str)> {
    const NEXT: &str = "fict-ignore-next-line";
    const SAME: &str = "fict-ignore";
    let lower = line.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix(NEXT)
        && boundary_or_empty(rest)
    {
        return Some((SuppressionMode::NextLine, &line[NEXT.len()..]));
    }
    if let Some(rest) = lower.strip_prefix(SAME)
        && boundary_or_empty(rest)
    {
        return Some((SuppressionMode::SameLine, &line[SAME.len()..]));
    }
    None
}

fn boundary_or_empty(rest: &str) -> bool {
    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
}

fn parse_suppression_codes(raw: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    raw.split(|character: char| character == ',' || character.is_whitespace())
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(str::to_ascii_uppercase)
        .filter(|code| seen.insert(code.clone()))
        .collect()
}

fn parse_fict_return(source: &str, comment: Comment) -> Option<ParsedFictReturn> {
    let content_span = comment.content_span();
    let raw = source.get(content_span.start as usize..content_span.end as usize)?;
    let normalized = normalize_jsdoc(raw);
    let marker = normalized.find("@fictReturn")?;
    let rest = normalized.get(marker + "@fictReturn".len()..)?.trim_start();
    let payload = extract_payload(rest)?;
    Some(ParsedFictReturn {
        comment_span: source_span(comment.span),
        attached_to: comment.attached_to,
        shape: parse_fict_return_shape(&payload),
        payload,
    })
}

fn normalize_jsdoc(raw: &str) -> String {
    source_lines(raw)
        .into_iter()
        .map(|line| {
            let line = line.trim_start();
            let line = line.strip_prefix('*').unwrap_or(line);
            line.strip_prefix(' ').unwrap_or(line).trim_end()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_payload(rest: &str) -> Option<String> {
    if rest.is_empty() {
        return None;
    }
    let first = rest.chars().next()?;
    if first == '{' || first == '[' {
        let close = if first == '{' { '}' } else { ']' };
        return extract_balanced(rest, first, close).map(str::to_owned);
    }
    rest.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
}

fn extract_balanced(rest: &str, open: char, close: char) -> Option<&str> {
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0_u32;
    for (index, character) in rest.char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
        } else if character == open {
            depth = depth.saturating_add(1);
        } else if character == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return rest.get(..index + character.len_utf8()).map(str::trim);
            }
        }
    }
    None
}

fn parse_fict_return_shape(payload: &str) -> Option<FictReturnShape> {
    if let Some(kind) = parse_reactive_kind(payload, false) {
        return Some(FictReturnShape::Direct(kind));
    }
    if let Some(body) = payload
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
    {
        if body.trim().is_empty() {
            return Some(FictReturnShape::Object(Vec::new()));
        }
        let mut properties = parse_properties(body, false);
        if properties.len() == 1 && properties[0].0 == "directAccessor" {
            return Some(FictReturnShape::Direct(properties.remove(0).1));
        }
        return (!properties.is_empty()).then_some(FictReturnShape::Object(properties));
    }
    if let Some(body) = payload
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    {
        let properties = parse_properties(body, true)
            .into_iter()
            .filter_map(|(key, kind)| key.parse::<u32>().ok().map(|index| (index, kind)))
            .collect::<Vec<_>>();
        return (!properties.is_empty()).then_some(FictReturnShape::Array(properties));
    }
    None
}

fn parse_properties(body: &str, numeric_only: bool) -> Vec<(String, ReactiveValueKind)> {
    split_unquoted(body, ',')
        .into_iter()
        .filter_map(|entry| {
            let (key, value) = split_once_unquoted(entry, ':')?;
            let key = parse_property_key(key)?;
            if numeric_only && !key.chars().all(|character| character.is_ascii_digit()) {
                return None;
            }
            Some((key, parse_reactive_kind(value, true)?))
        })
        .collect()
}

fn parse_property_key(raw: &str) -> Option<String> {
    let value = raw.trim();
    if let Some(unquoted) = unquote(value) {
        return Some(unquoted);
    }
    (!value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$')))
    .then(|| value.to_owned())
}

fn parse_reactive_kind(raw: &str, allow_bare: bool) -> Option<ReactiveValueKind> {
    let value = raw.trim();
    let owned;
    let normalized = if let Some(unquoted) = unquote(value) {
        owned = unquoted;
        owned.as_str()
    } else if allow_bare {
        value
    } else {
        return None;
    };
    match normalized {
        "signal" => Some(ReactiveValueKind::Signal),
        "memo" => Some(ReactiveValueKind::Memo),
        "store" => Some(ReactiveValueKind::Store),
        _ => None,
    }
}

fn unquote(value: &str) -> Option<String> {
    let quote = value.chars().next()?;
    if !matches!(quote, '\'' | '"') || value.chars().last()? != quote || value.len() < 2 {
        return None;
    }
    let body = value.get(quote.len_utf8()..value.len() - quote.len_utf8())?;
    let mut output = String::new();
    let mut escaped = false;
    for character in body.chars() {
        if escaped {
            output.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    if escaped {
        output.push('\\');
    }
    Some(output)
}

fn split_once_unquoted(value: &str, separator: char) -> Option<(&str, &str)> {
    let index = split_index_unquoted(value, separator)?;
    Some((
        value.get(..index)?,
        value.get(index + separator.len_utf8()..)?,
    ))
}

fn split_unquoted(value: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = value;
    while let Some(index) = split_index_unquoted(rest, separator) {
        if let Some(part) = rest.get(..index) {
            parts.push(part);
        }
        let Some(next) = rest.get(index + separator.len_utf8()..) else {
            break;
        };
        rest = next;
    }
    parts.push(rest);
    parts
}

fn split_index_unquoted(value: &str, separator: char) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character == separator {
            return Some(index);
        }
    }
    None
}

fn source_lines(source: &str) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0_usize;
    let mut index = 0_usize;
    while index < bytes.len() {
        if let Some(length) = line_terminator_len(bytes, index) {
            if let Some(line) = source.get(start..index) {
                lines.push(line);
            }
            index = index.saturating_add(length);
            start = index;
            continue;
        }
        index += 1;
    }
    if let Some(line) = source.get(start..) {
        lines.push(line);
    }
    lines
}

/// One-based source-line lookup shared by source facts and diagnostic policy.
pub struct SourceLineIndex {
    starts: Vec<u32>,
}

impl SourceLineIndex {
    /// Index ECMAScript line terminators in one source string.
    #[must_use]
    pub fn new(source: &str) -> Self {
        let bytes = source.as_bytes();
        let mut starts = vec![0];
        let mut index = 0_usize;
        while index < bytes.len() {
            if let Some(length) = line_terminator_len(bytes, index) {
                index = index.saturating_add(length);
                starts.push(count_u32(index));
                continue;
            }
            index += 1;
        }
        Self { starts }
    }

    /// Return the one-based line containing a byte offset.
    #[must_use]
    pub fn line_of(&self, offset: u32) -> u32 {
        count_u32(self.starts.partition_point(|start| *start <= offset))
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

fn source_span(span: oxc::span::Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).expect("OXC spans must be ordered")
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
