//! Shared CIF 1.1 lexer for the small-molecule CIF (`cif.rs`) and the
//! PDBx/mmCIF (`mmcif.rs`) parsers.
//!
//! A CIF document is a stream of whitespace-separated tokens, not a sequence
//! of lines: a `loop_` row may wrap onto several lines, and a single value may
//! contain spaces when it is quoted. The rules implemented here follow the
//! CIF 1.1 syntax:
//!
//! * `#` at the start of a token begins a comment that runs to end of line.
//! * `'…'` / `"…"` quote a value; a quote only closes the value when it is
//!   followed by whitespace or end of input, so `'O5'' ` style embedded quotes
//!   survive (`"C1'"` → `C1'`). A quoted value may not span lines.
//! * A `;` in column 0 opens a multi-line text field that is closed by the next
//!   line starting with `;`.
//! * Unquoted `?` (unknown) and `.` (inapplicable) are missing values; quoted
//!   `'?'` / `'.'` are literal strings.
//! * `loop_`, `data_…`, `save_…`, `global_` and `stop_` are reserved words and
//!   any bare token starting with `_` is a tag.
//!
//! Every value is a borrowed slice of the input, so lexing allocates nothing.
//! A [`Document`] records only loop headers and byte spans; loop rows are
//! re-lexed on demand by a [`RowCursor`], which keeps memory flat even for
//! million-atom mmCIF files.

/// One CIF data value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Value<'a> {
    /// The value text without its delimiters (quotes or `;` lines).
    pub text: &'a str,
    /// `true` when the value was quoted or was a `;` text field.
    pub quoted: bool,
}

/// The value used for a column a row does not carry.
pub const MISSING: Value<'static> = Value {
    text: "?",
    quoted: false,
};

impl<'a> Value<'a> {
    /// `true` for the unquoted CIF null values `?` (unknown) and `.`
    /// (inapplicable).
    pub fn is_missing(&self) -> bool {
        !self.quoted && (self.text == "?" || self.text == ".")
    }

    /// The value text, or `None` when the value is missing.
    pub fn get(&self) -> Option<&'a str> {
        if self.is_missing() {
            None
        } else {
            Some(self.text)
        }
    }

    /// Parse the value as a CIF number (standard uncertainty stripped).
    pub fn as_f32(&self) -> Option<f32> {
        self.get().and_then(parse_cif_number)
    }

    /// Parse the value as an unsigned integer.
    pub fn as_u32(&self) -> Option<u32> {
        self.get().and_then(|s| s.parse().ok())
    }

    /// Parse the value as a signed integer (e.g. an author residue number,
    /// which is below 1 for expression tags).
    pub fn as_i32(&self) -> Option<i32> {
        self.get().and_then(|s| s.parse().ok())
    }
}

/// Strip a trailing parenthesized standard uncertainty from a CIF number.
/// e.g. `"5.6402(1)"` → `"5.6402"`, `"90.000"` → `"90.000"`.
pub fn strip_su(s: &str) -> &str {
    match s.find('(') {
        Some(i) => &s[..i],
        None => s,
    }
}

/// Parse a CIF numeric value such as `1.23`, `-0.5(2)` or `1.2E-3(4)`.
/// Missing values and non-numbers return `None`.
pub fn parse_cif_number(s: &str) -> Option<f32> {
    strip_su(s.trim()).parse().ok()
}

/// Strip a single pair of surrounding single/double quotes from a raw value.
pub fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'\'' && b[b.len() - 1] == b'\'') || (b[0] == b'"' && b[b.len() - 1] == b'"'))
    {
        return &s[1..s.len() - 1];
    }
    s
}

/// Case-insensitive ASCII `starts_with`.
pub fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Case-insensitive ASCII substring test, used as a cheap pre-check before
/// lexing a whole document for a rarely present tag.
pub fn contains_ci(hay: &str, needle: &str) -> bool {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    let Some(&first) = n.first() else {
        return true;
    };
    if h.len() < n.len() {
        return false;
    }
    let (lo, up) = (first.to_ascii_lowercase(), first.to_ascii_uppercase());
    let last = h.len() - n.len();
    let mut i = 0;
    while let Some(k) = h[i..=last].iter().position(|&c| c == lo || c == up) {
        i += k;
        if h[i..i + n.len()].eq_ignore_ascii_case(n) {
            return true;
        }
        if i == last {
            break;
        }
        i += 1;
    }
    false
}

/// A lexical CIF token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token<'a> {
    /// A data name such as `_cell_length_a` (original case).
    Tag(&'a str),
    Value(Value<'a>),
    Loop,
    /// `data_<name>`; carries the block name.
    DataBlock(&'a str),
    /// `save_<name>` (empty name for a save-frame terminator).
    Save(&'a str),
    Global,
    Stop,
}

/// CIF whitespace (space, tab, CR, LF, VT, FF) as a lookup table: the lexer
/// tests every input byte against it.
const WS: [bool; 256] = {
    let mut t = [false; 256];
    t[b' ' as usize] = true;
    t[b'\t' as usize] = true;
    t[b'\r' as usize] = true;
    t[b'\n' as usize] = true;
    t[0x0b] = true;
    t[0x0c] = true;
    t
};

#[inline]
fn is_ws(b: u8) -> bool {
    WS[b as usize]
}

/// Classify a bare (unquoted) word as a tag, reserved word, or value.
fn classify_bare(word: &str) -> Token<'_> {
    let b = word.as_bytes();
    if b[0] == b'_' {
        return Token::Tag(word);
    }
    // Reserved words all start with d/g/l/s; skip the comparisons otherwise.
    if matches!(b[0] | 0x20, b'd' | b'g' | b'l' | b's') && b.len() >= 5 {
        if word.eq_ignore_ascii_case("loop_") {
            return Token::Loop;
        } else if starts_with_ci(word, "data_") {
            return Token::DataBlock(&word[5..]);
        } else if starts_with_ci(word, "save_") {
            return Token::Save(&word[5..]);
        } else if word.eq_ignore_ascii_case("global_") {
            return Token::Global;
        } else if word.eq_ignore_ascii_case("stop_") {
            return Token::Stop;
        }
    }
    Token::Value(Value {
        text: word,
        quoted: false,
    })
}

/// Streaming CIF tokenizer over `text[pos..end]`.
pub struct Lexer<'a> {
    text: &'a str,
    pos: usize,
    end: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            pos: 0,
            end: text.len(),
        }
    }

    /// Lex only `text[start..end]` while still resolving column-0 `;` and
    /// quote-closing rules against the full text.
    fn with_range(text: &'a str, start: usize, end: usize) -> Self {
        Self {
            text,
            pos: start,
            end,
        }
    }

    /// Byte offset just past the last token returned.
    pub fn position(&self) -> usize {
        self.pos
    }

    fn skip_ws_and_comments(&mut self) {
        let b = &self.text.as_bytes()[..self.end];
        let mut i = self.pos;
        loop {
            i += b[i..]
                .iter()
                .position(|&c| !is_ws(c))
                .unwrap_or(b.len() - i);
            if i < b.len() && b[i] == b'#' {
                i += b[i..]
                    .iter()
                    .position(|&c| c == b'\n')
                    .unwrap_or(b.len() - i);
            } else {
                break;
            }
        }
        self.pos = i;
    }

    /// Next token together with the byte offset where it starts.
    pub fn next_spanned(&mut self) -> Option<(usize, Token<'a>)> {
        self.skip_ws_and_comments();
        if self.pos >= self.end {
            return None;
        }
        let text = self.text;
        let b = text.as_bytes();
        let start = self.pos;
        let c = b[start];

        // Multi-line text field: `;` in column 0 up to the next `\n;`.
        if c == b';' && (start == 0 || b[start - 1] == b'\n') {
            let body = start + 1;
            let (content_end, next) = match text[body..self.end].find("\n;") {
                Some(k) => (body + k, body + k + 2),
                None => (self.end, self.end),
            };
            let mut content = &text[body..content_end];
            if let Some(stripped) = content.strip_suffix('\r') {
                content = stripped;
            }
            self.pos = next;
            return Some((
                start,
                Token::Value(Value {
                    text: content,
                    quoted: true,
                }),
            ));
        }

        // Quoted value: closes on a matching quote followed by whitespace/EOF.
        if c == b'\'' || c == b'"' {
            let mut i = start + 1;
            while i < self.end {
                let d = b[i];
                if d == b'\n' {
                    break;
                }
                if d == c && (i + 1 >= b.len() || is_ws(b[i + 1])) {
                    self.pos = i + 1;
                    return Some((
                        start,
                        Token::Value(Value {
                            text: &text[start + 1..i],
                            quoted: true,
                        }),
                    ));
                }
                i += 1;
            }
            // Unterminated: take the rest of the line (lenient, as before).
            self.pos = i;
            let mut content = &text[start + 1..i];
            if let Some(stripped) = content.strip_suffix('\r') {
                content = stripped;
            }
            return Some((
                start,
                Token::Value(Value {
                    text: content,
                    quoted: true,
                }),
            ));
        }

        // Bare word.
        let rest = &b[start + 1..self.end];
        let i = start + 1 + rest.iter().position(|&c| is_ws(c)).unwrap_or(rest.len());
        self.pos = i;
        Some((start, classify_bare(&text[start..i])))
    }
}

impl<'a> Iterator for Lexer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        self.next_spanned().map(|(_, t)| t)
    }
}

/// Split one line into its (quote-aware) values. Used where a format is
/// conventionally line-oriented and the file may be malformed (symmetry
/// operation loops).
pub fn split_line(line: &str) -> Vec<&str> {
    Lexer::new(line)
        .filter_map(|t| match t {
            Token::Value(v) => Some(v.text),
            Token::Tag(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// A `loop_` block: its tags plus the byte span of its values.
#[derive(Debug)]
pub struct Loop<'a> {
    text: &'a str,
    /// Loop tags in original case.
    pub tags: Vec<&'a str>,
    start: usize,
    end: usize,
    n_values: usize,
}

impl<'a> Loop<'a> {
    /// Column index of `tag` (case-insensitive).
    pub fn column(&self, tag: &str) -> Option<usize> {
        self.tags.iter().position(|t| t.eq_ignore_ascii_case(tag))
    }

    /// `true` when any tag starts with `prefix` (case-insensitive).
    pub fn has_tag_prefix(&self, prefix: &str) -> bool {
        self.tags.iter().any(|t| starts_with_ci(t, prefix))
    }

    /// Number of complete rows.
    pub fn n_rows(&self) -> usize {
        self.n_values / self.tags.len()
    }

    /// Number of values in a trailing incomplete row (0 when the value count
    /// is a multiple of the column count).
    pub fn partial_row_len(&self) -> usize {
        self.n_values % self.tags.len()
    }

    /// The raw text holding the loop's values.
    pub fn body(&self) -> &'a str {
        &self.text[self.start..self.end]
    }

    /// A cursor over the loop's complete rows.
    pub fn cursor(&self) -> RowCursor<'a> {
        RowCursor {
            lex: Lexer::with_range(self.text, self.start, self.end),
            ncols: self.tags.len(),
            row: Vec::with_capacity(self.tags.len()),
        }
    }

    /// All complete rows, collected (for small categories).
    pub fn rows(&self) -> Vec<Vec<Value<'a>>> {
        let mut out = Vec::with_capacity(self.n_rows());
        let mut cur = self.cursor();
        while let Some(row) = cur.next_row() {
            out.push(row.to_vec());
        }
        out
    }
}

/// Re-lexes a loop body one row at a time into a reused buffer.
pub struct RowCursor<'a> {
    lex: Lexer<'a>,
    ncols: usize,
    row: Vec<Value<'a>>,
}

impl<'a> RowCursor<'a> {
    /// The next complete row, or `None` at the end of the loop (a trailing
    /// incomplete row is not returned; see [`Loop::partial_row_len`]).
    pub fn next_row(&mut self) -> Option<&[Value<'a>]> {
        self.row.clear();
        while self.row.len() < self.ncols {
            match self.lex.next() {
                Some(Token::Value(v)) => self.row.push(v),
                _ => return None,
            }
        }
        Some(&self.row)
    }
}

/// A top-level CIF item.
#[derive(Debug)]
pub enum Item<'a> {
    /// A `_tag value` pair.
    Pair {
        tag: &'a str,
        value: Value<'a>,
    },
    Loop(Loop<'a>),
}

/// A lexed CIF document: every tag/value pair and loop, in file order, across
/// all data blocks.
#[derive(Debug)]
pub struct Document<'a> {
    pub items: Vec<Item<'a>>,
}

impl<'a> Document<'a> {
    pub fn parse(text: &'a str) -> Self {
        let mut lex = Lexer::new(text);
        let mut items = Vec::new();
        let mut pending = lex.next_spanned();
        while let Some((_, tok)) = pending {
            pending = lex.next_spanned();
            match tok {
                Token::Tag(tag) => {
                    // A tag without a value (malformed) is ignored and the
                    // following token is processed normally.
                    if let Some((_, Token::Value(value))) = pending {
                        items.push(Item::Pair { tag, value });
                        pending = lex.next_spanned();
                    }
                }
                Token::Loop => {
                    let mut tags = Vec::new();
                    while let Some((_, Token::Tag(t))) = pending {
                        tags.push(t);
                        pending = lex.next_spanned();
                    }
                    let start = pending.map_or(text.len(), |(s, _)| s);
                    let mut end = start;
                    let mut n_values = 0usize;
                    while let Some((_, Token::Value(_))) = pending {
                        n_values += 1;
                        end = lex.position();
                        pending = lex.next_spanned();
                    }
                    if !tags.is_empty() {
                        items.push(Item::Loop(Loop {
                            text,
                            tags,
                            start,
                            end,
                            n_values,
                        }));
                    }
                }
                // Block headers, save frames and stray values carry nothing
                // the structure parsers read.
                _ => {}
            }
        }
        Document { items }
    }

    /// All loops in file order.
    pub fn loops(&self) -> impl Iterator<Item = &Loop<'a>> {
        self.items.iter().filter_map(|it| match it {
            Item::Loop(l) => Some(l),
            Item::Pair { .. } => None,
        })
    }

    /// All `_tag value` pairs in file order.
    pub fn pairs(&self) -> impl Iterator<Item = (&'a str, Value<'a>)> + '_ {
        self.items.iter().filter_map(|it| match it {
            Item::Pair { tag, value } => Some((*tag, *value)),
            Item::Loop(_) => None,
        })
    }

    /// The value of the last `tag value` pair named `tag` (case-insensitive).
    pub fn value(&self, tag: &str) -> Option<Value<'a>> {
        self.pairs()
            .filter(|(t, _)| t.eq_ignore_ascii_case(tag))
            .last()
            .map(|(_, v)| v)
    }

    /// `true` when any pair tag or loop tag starts with `prefix`.
    pub fn has_tag_prefix(&self, prefix: &str) -> bool {
        self.items.iter().any(|it| match it {
            Item::Pair { tag, .. } => starts_with_ci(tag, prefix),
            Item::Loop(l) => l.has_tag_prefix(prefix),
        })
    }

    /// The rows of a dotted category (e.g. `_struct_conn.`).
    ///
    /// The first `loop_` holding a tag with `prefix` wins; when the category
    /// is not looped, its `tag value` pairs (the single-record form PDB
    /// entries use for one-row categories) become one row.
    pub fn category(&self, prefix: &str) -> Category<'a> {
        if let Some(l) = self.loops().find(|l| l.has_tag_prefix(prefix)) {
            return Category {
                tags: l.tags.clone(),
                rows: l.rows(),
            };
        }
        let (tags, row): (Vec<&str>, Vec<Value>) = self
            .pairs()
            .filter(|(t, _)| starts_with_ci(t, prefix))
            .unzip();
        Category {
            tags,
            rows: if row.is_empty() {
                Vec::new()
            } else {
                vec![row]
            },
        }
    }
}

/// The tags and rows of one category.
#[derive(Debug)]
pub struct Category<'a> {
    pub tags: Vec<&'a str>,
    pub rows: Vec<Vec<Value<'a>>>,
}

impl<'a> Category<'a> {
    /// Column index of `tag` (case-insensitive).
    pub fn col(&self, tag: &str) -> Option<usize> {
        self.tags.iter().position(|t| t.eq_ignore_ascii_case(tag))
    }
}

/// Fetch a row value by optional column index; absent columns read as
/// missing.
pub fn field<'a>(row: &[Value<'a>], idx: Option<usize>) -> Value<'a> {
    idx.and_then(|i| row.get(i).copied()).unwrap_or(MISSING)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(text: &str) -> Vec<&str> {
        Lexer::new(text)
            .map(|t| match t {
                Token::Value(v) => v.text,
                Token::Tag(t) => t,
                _ => "<reserved>",
            })
            .collect()
    }

    #[test]
    fn value_missing_and_numbers() {
        let q = |text| Value {
            text,
            quoted: false,
        };
        assert!(q("?").is_missing());
        assert!(q(".").is_missing());
        assert!(!q("A").is_missing());
        // Quoted '?' is a literal string, not a null.
        let quoted = Value {
            text: "?",
            quoted: true,
        };
        assert!(!quoted.is_missing());
        assert_eq!(quoted.get(), Some("?"));
        assert_eq!(q("?").get(), None);
        assert_eq!(q("1.25(3)").as_f32(), Some(1.25));
        assert_eq!(q("-0.5").as_f32(), Some(-0.5));
        assert_eq!(q("1.5E2(4)").as_f32(), Some(150.0));
        assert_eq!(q(".").as_f32(), None);
        assert_eq!(q("abc").as_f32(), None);
        assert_eq!(q("12").as_u32(), Some(12));
        assert_eq!(q("?").as_u32(), None);
        assert_eq!(q("-3").as_i32(), Some(-3));
        assert_eq!(q("-3").as_u32(), None);
        assert_eq!(q(".").as_i32(), None);
        assert!(MISSING.is_missing());
    }

    #[test]
    fn strip_helpers() {
        assert_eq!(strip_su("5.6402(1)"), "5.6402");
        assert_eq!(strip_su("90.000"), "90.000");
        assert_eq!(strip_su("1.234(56)"), "1.234");
        assert_eq!(parse_cif_number(" 3.5(2) "), Some(3.5));
        assert_eq!(strip_quotes("'THR'"), "THR");
        assert_eq!(strip_quotes("\"CA\""), "CA");
        assert_eq!(strip_quotes(" THR "), "THR");
        assert_eq!(strip_quotes("'"), "'");
        assert!(starts_with_ci("_ATOM_SITE.x", "_atom_site."));
        assert!(!starts_with_ci("_atom", "_atom_site"));
        assert!(contains_ci("ab _Symmetry_Equiv_Pos_As_XYZ", "pos_as_xyz"));
        assert!(contains_ci("xyz", "XYZ"));
        assert!(contains_ci("anything", ""));
        assert!(!contains_ci("x-y-z xy", "xyz"));
        assert!(!contains_ci("xy", "xyz"));
        assert!(!contains_ci("xa", "xy"));
    }

    #[test]
    fn quoted_values_keep_spaces_and_embedded_quotes() {
        assert_eq!(
            values("'C1 A' \"O5'\" C1' 'it''s' \"a\"b\" x"),
            vec!["C1 A", "O5'", "C1'", "it''s", "a\"b", "x"]
        );
        let toks: Vec<Token> = Lexer::new("'?' ?").collect();
        assert_eq!(
            toks,
            vec![
                Token::Value(Value {
                    text: "?",
                    quoted: true
                }),
                Token::Value(Value {
                    text: "?",
                    quoted: false
                }),
            ]
        );
    }

    #[test]
    fn unterminated_quote_runs_to_end_of_line() {
        assert_eq!(values("'abc def\r\nnext"), vec!["abc def", "next"]);
        assert_eq!(values("'abc"), vec!["abc"]);
    }

    #[test]
    fn comments_and_reserved_words() {
        let toks: Vec<Token> =
            Lexer::new("data_blk # comment 'x\nLOOP_ _a.b save_frame save_ global_ stop_ a#b")
                .collect();
        assert_eq!(
            toks,
            vec![
                Token::DataBlock("blk"),
                Token::Loop,
                Token::Tag("_a.b"),
                Token::Save("frame"),
                Token::Save(""),
                Token::Global,
                Token::Stop,
                Token::Value(Value {
                    text: "a#b",
                    quoted: false
                }),
            ]
        );
    }

    #[test]
    fn semicolon_text_fields() {
        let text = "_a\n;line one\nline two\r\n;\n_b x;y\n;unterminated";
        let toks: Vec<Token> = Lexer::new(text).collect();
        assert_eq!(toks[0], Token::Tag("_a"));
        assert_eq!(
            toks[1],
            Token::Value(Value {
                text: "line one\nline two",
                quoted: true
            })
        );
        assert_eq!(toks[2], Token::Tag("_b"));
        // A `;` that is not in column 0 is an ordinary character.
        assert_eq!(
            toks[3],
            Token::Value(Value {
                text: "x;y",
                quoted: false
            })
        );
        assert_eq!(
            toks[4],
            Token::Value(Value {
                text: "unterminated",
                quoted: true
            })
        );
        assert_eq!(toks.len(), 5);
    }

    #[test]
    fn split_line_is_quote_aware() {
        assert_eq!(split_line("1 'x, y, z'"), vec!["1", "x, y, z"]);
        assert_eq!(split_line("_tag value"), vec!["_tag", "value"]);
        assert_eq!(split_line("loop_"), Vec::<&str>::new());
    }

    const DOC: &str = "data_test
_cell.length_a 10.0(2)
_cell.length_a
  12.5
_orphan_tag
loop_
_x.a
_x.b
_x.c
1 'two words' 3
# comment between rows
4 5
6
;text
field
;
8 9 10
9
_z.kv 'v'
stray
loop_
_y.only
";

    #[test]
    fn document_pairs_loops_and_rows() {
        let doc = Document::parse(DOC);
        // Last occurrence wins; a value may sit on the line after its tag.
        assert_eq!(doc.value("_CELL.LENGTH_A").unwrap().as_f32(), Some(12.5));
        assert!(doc.value("_orphan_tag").is_none());
        assert_eq!(doc.value("_z.kv").unwrap().text, "v");
        assert!(doc.has_tag_prefix("_x."));
        assert!(doc.has_tag_prefix("_z."));
        assert!(!doc.has_tag_prefix("_w."));

        let loops: Vec<&Loop> = doc.loops().collect();
        assert_eq!(loops.len(), 2);
        let l = loops[0];
        assert_eq!(l.column("_X.B"), Some(1));
        assert_eq!(l.column("_x.d"), None);
        // Rows are a token stream: they wrap lines and contain text fields.
        assert_eq!(l.n_rows(), 3);
        assert_eq!(l.partial_row_len(), 2);
        let rows = l.rows();
        let texts: Vec<Vec<&str>> = rows
            .iter()
            .map(|r| r.iter().map(|v| v.text).collect())
            .collect();
        assert_eq!(
            texts,
            vec![
                vec!["1", "two words", "3"],
                vec!["4", "5", "6"],
                vec!["text\nfield", "8", "9"],
            ]
        );
        assert!(l.body().starts_with("1 'two words'"));
        assert!(l.body().ends_with("8 9 10\n9"));
        // The empty `_y.only` loop is kept with no rows.
        assert_eq!(loops[1].n_rows(), 0);
        assert_eq!(loops[1].partial_row_len(), 0);
    }

    #[test]
    fn document_category_loop_and_key_value_forms() {
        let doc = Document::parse(DOC);
        let x = doc.category("_x.");
        assert_eq!(x.tags.len(), 3);
        assert_eq!(x.rows.len(), 3);
        assert_eq!(x.col("_x.c"), Some(2));
        assert_eq!(field(&x.rows[0], x.col("_x.b")).text, "two words");
        assert!(field(&x.rows[0], x.col("_x.missing")).is_missing());
        assert!(field(&x.rows[0], Some(99)).is_missing());

        let z = doc.category("_z.");
        assert_eq!(z.rows.len(), 1);
        assert_eq!(field(&z.rows[0], z.col("_z.kv")).text, "v");

        let none = doc.category("_nothing.");
        assert!(none.tags.is_empty() && none.rows.is_empty());
    }

    #[test]
    fn document_ignores_loop_without_tags_and_handles_eof() {
        let doc = Document::parse("loop_ 1 2 3 loop_ _a.x");
        let loops: Vec<&Loop> = doc.loops().collect();
        assert_eq!(loops.len(), 1);
        assert_eq!(loops[0].n_rows(), 0);
        assert_eq!(loops[0].body(), "");
    }
}
