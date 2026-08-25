# Security Policy

## Supported Versions

Security fixes are applied to the latest released version. Please make sure
you are running the most recent release of the `megane` package (PyPI),
`megane-viewer` (npm), or the VSCode extension before reporting.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues.**

Instead, use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/megane-labs/megane/security) of this
repository and click **"Report a vulnerability"**. This opens a private
advisory that only the maintainer can see.

Please include as much of the following as you can:

- The affected component (Python package, webapp, Jupyter widget, JupyterLab
  extension, VSCode extension, or a specific file parser) and version
- Steps to reproduce, ideally with a minimal input file if the issue is in a
  parser
- The impact you believe the issue has (e.g. arbitrary code execution when
  opening a crafted structure file)

You should receive an initial response within a week. Once the issue is
confirmed and fixed, the fix ships in the next release and the advisory is
published with credit to the reporter (unless you prefer to stay anonymous).

Because megane parses untrusted files (structure and trajectory formats) in
Rust/WASM and Python, parser crashes on malformed input are welcome as
regular bug reports — the private channel is for issues with a plausible
security impact such as memory unsafety, sandbox escape, or code execution.
