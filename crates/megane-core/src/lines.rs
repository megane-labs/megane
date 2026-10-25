//! Line-by-line scanning of a text file, whole or as consecutive windows.
//!
//! The frame index builders of the multi-frame text formats (XYZ, PDB models,
//! LAMMPS dumps) only need each line and where it sits in the file. Feeding
//! them lines instead of a `Vec<&str>` of the whole file lets the same builder
//! index a file held in memory ([`for_each_line`]) and one read window by
//! window ([`scan_window`]) without ever holding it whole — the browser host
//! indexes a multi-gigabyte trajectory that way and reads each frame's bytes
//! only when it is shown.
//!
//! Lines are split exactly like [`str::lines`]: on `'\n'`, with one trailing
//! `'\r'` dropped, and no empty line after a final newline.

/// Call `f(line, start, end)` for every line of `text`, where `start..end` is
/// the line's byte range including its line break.
pub fn for_each_line<F>(text: &str, mut f: F) -> Result<(), String>
where
    F: FnMut(&str, u64, u64) -> Result<(), String>,
{
    let mut pos = 0u64;
    for raw in text.split_inclusive('\n') {
        let end = pos + raw.len() as u64;
        f(trim_line_break(raw), pos, end)?;
        pos = end;
    }
    Ok(())
}

/// Call `f(line, start, end)` for every complete line of `window`, the bytes
/// of a file from offset `start` on, and return how many bytes those lines
/// span: the next window starts that far on. A line is complete when its
/// `'\n'` is in the window, or when `at_eof` says the window runs to the end
/// of the file. Returns 0 when not even one line is complete (the window is
/// too small for it).
pub fn scan_window<F>(window: &[u8], at_eof: bool, start: u64, mut f: F) -> Result<usize, String>
where
    F: FnMut(&str, u64, u64) -> Result<(), String>,
{
    let complete = if at_eof {
        window.len()
    } else {
        match window.iter().rposition(|&b| b == b'\n') {
            Some(i) => i + 1,
            None => return Ok(0),
        }
    };
    // Only whole lines are decoded, and a '\n' byte never sits inside a
    // multi-byte UTF-8 sequence, so a window boundary never splits a character.
    let text = std::str::from_utf8(&window[..complete])
        .map_err(|_| "file is not valid UTF-8".to_string())?;
    for_each_line(text, |line, s, e| f(line, start + s, start + e))?;
    Ok(complete)
}

/// Feed `text` to `f` the way a host indexing a file does: in windows of
/// `window` bytes (grown when a line does not fit), each continuing where the
/// previous one's complete lines ended. Test helper for the index builders.
#[cfg(test)]
pub(crate) fn feed_in_windows<F>(text: &str, window: usize, mut f: F) -> Result<(), String>
where
    F: FnMut(&str, u64, u64) -> Result<(), String>,
{
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut size = window.max(1);
    while start < bytes.len() {
        let end = (start + size).min(bytes.len());
        let used = scan_window(&bytes[start..end], end == bytes.len(), start as u64, &mut f)?;
        if used == 0 {
            size *= 2;
            continue;
        }
        start += used;
        size = window.max(1);
    }
    Ok(())
}

fn trim_line_break(raw: &str) -> &str {
    let line = raw.strip_suffix('\n').unwrap_or(raw);
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(text: &str) -> Vec<(String, u64, u64)> {
        let mut out = Vec::new();
        for_each_line(text, |l, s, e| {
            out.push((l.to_string(), s, e));
            Ok(())
        })
        .unwrap();
        out
    }

    #[test]
    fn splits_like_str_lines_with_byte_ranges() {
        for text in ["", "a", "a\n", "a\nb", "a\r\nb\r\n", "\n\n", "x\n\ny"] {
            let got: Vec<String> = collect(text).into_iter().map(|(l, _, _)| l).collect();
            let want: Vec<String> = text.lines().map(str::to_string).collect();
            assert_eq!(got, want, "{text:?}");
        }
        assert_eq!(
            collect("ab\r\ncd\nef"),
            vec![
                ("ab".to_string(), 0, 4),
                ("cd".to_string(), 4, 7),
                ("ef".to_string(), 7, 9)
            ]
        );
    }

    #[test]
    fn windows_see_the_same_lines_as_the_whole_text() {
        let text = "first line\nsecond é line\r\n\nlast";
        let whole = collect(text);
        for size in 1..=text.len() {
            let bytes = text.as_bytes();
            let mut got = Vec::new();
            let mut start = 0usize;
            let mut window = size;
            while start < bytes.len() {
                let end = (start + window).min(bytes.len());
                let at_eof = end == bytes.len();
                let used = scan_window(&bytes[start..end], at_eof, start as u64, |l, s, e| {
                    got.push((l.to_string(), s, e));
                    Ok(())
                })
                .unwrap();
                if used == 0 {
                    window *= 2; // one line longer than the window
                    continue;
                }
                start += used;
                window = size;
            }
            assert_eq!(got, whole, "window {size}");
        }
    }

    #[test]
    fn rejects_bytes_that_are_not_utf8() {
        let err = scan_window(&[b'a', 0xff, b'\n'], true, 0, |_, _, _| Ok(())).unwrap_err();
        assert!(err.contains("UTF-8"));
    }

    #[test]
    fn stops_at_the_first_error() {
        let mut seen = 0;
        let err = for_each_line("a\nb\nc", |l, _, _| {
            seen += 1;
            if l == "b" {
                Err("bad".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(err, Err("bad".to_string()));
        assert_eq!(seen, 2);
    }
}
