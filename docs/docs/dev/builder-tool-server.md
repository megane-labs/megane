---
title: Writing a Builder Tool Server
---

A hands-on guide to adding your own buttons to Megane Builder's **Tools** menu.
Your code runs in a Python [MCP](https://modelcontextprotocol.io/) server; the
Builder connects to it, turns every tool it marks as a Builder tool into a
button with a generated form, and puts the structure it returns into the
document. No change to Megane is needed.

If you only want to _use_ the reference tools (liquid box, polymer chain,
solvate), read [Python tools](../guide/builder.md#python-tools) in the Builder
guide. The rules every server has to follow are in the
[Builder Tool Contract](builder-tools.md); this page walks through one server
built with the SDK that implements them, from an empty folder to buttons in the
Builder.

## What you need

- Python 3.11 or newer and [uv](https://docs.astral.sh/uv/).
- The SDK, which ships with the reference server in
  [hodakamori/megane-builder-tools](https://github.com/hodakamori/megane-builder-tools).
  It is not on PyPI yet, so install it from Git.
- A Megane Builder with a *Tools* menu: the web app (`megane serve`, a local
  build, the hosted demo), VS Code, or JupyterLab (see
  [Where it works](#where-it-works)).

```bash
uv init my-tools && cd my-tools
uv add "megane-builder-tools @ git+https://github.com/hodakamori/megane-builder-tools"
```

The package pulls in packmol, RadonPy and RDKit for the reference tools, so the
first install takes a while.

## 1. Write the tools

A tool is a typed Python function under `@builder_tool`. Save this as
`my_tools.py`:

```python
"""My lab's megane Builder tools."""

import argparse
import secrets
import sys
from typing import Annotated

import numpy as np
from pydantic import Field

from megane_builder_tools.sdk import (
    BuilderResult,
    DocumentInput,
    Element,
    Length,
    Seed,
    Structure,
    ToolError,
    builder_tool,
)
from megane_builder_tools.server import create_server, http_app


@builder_tool(title="Argon gas", category="bulk", apply="new_document", expected_seconds=1)
def argon_gas(
    count: Annotated[int, Field(ge=1, le=10_000, title="Atoms", examples=[100])],
    seed: Seed,
    edge: Annotated[Length, Field(gt=0, title="Box edge")] = 30.0,
) -> BuilderResult:
    """Place argon atoms uniformly at random in a cubic box."""
    positions = np.random.default_rng(seed).random((count, 3)) * edge
    structure = Structure.from_arrays([18] * count, positions, cell=np.eye(3) * edge)
    return BuilderResult(name="argon", structure=structure)


@builder_tool(title="Scatter atoms", category="other", apply="insert", expected_seconds=1)
def scatter_atoms(
    document: DocumentInput,
    element: Annotated[Element, Field(title="Element", examples=[11])],
    count: Annotated[int, Field(ge=1, le=1_000, title="Atoms", examples=[4])],
    seed: Seed,
) -> BuilderResult:
    """Add atoms of one element at random positions inside the open structure's cell."""
    cell = document.cell_matrix()
    if cell is None:
        raise ToolError("Scatter atoms needs a periodic cell; set one with Structure › Set cell…")
    fractional = np.random.default_rng(seed).random((count, 3))
    structure = Structure.from_arrays([element] * count, fractional @ cell)
    return BuilderResult(name="scattered", structure=structure)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", action="store_true", help="serve Streamable HTTP instead of stdio")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()

    server = create_server(tools=[argon_gas, scatter_atoms])
    if not args.http:
        server.run("stdio")
        return

    import uvicorn

    token = secrets.token_urlsafe(24)
    print(f"bearer token {token}", file=sys.stderr, flush=True)
    app = http_app(server, token=token, host="127.0.0.1", port=args.port, allowed_origins=args.allow_origin)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
```

What the pieces mean:

- **`@builder_tool(...)`** turns the function into a Builder button. `title` is
  the button label, `category` the Tools-menu group (`bulk`, `molecule`,
  `polymer`, `surface`, `solvation`, `other`), and `apply` how the result
  enters the document: `new_document` replaces the open document,
  `insert` adds the returned atoms to it as one Undo step
  ([§5.2](builder-tools.md#52-apply-modes)). The docstring's first sentence
  is the tooltip; the whole docstring is what an LLM client reads.
- **Parameters become the form.** Each parameter's type and `Field(...)`
  constraints become a form field. The SDK's annotated types pick the Builder
  widget and the unit: `Seed` (pre-filled with a fresh random value, with a
  *New seed* button; declaring it marks the tool as stochastic), `Element` (atomic number, shown as the
  element), `Length` / `Density` / `Angle` / `Temperature` (shown with Å,
  g/cm³, °, K), `Cell`, `Selection`, `MoleculeInput` (the molecule-library
  picker) and `atom_of("<molecule parameter>")` (one atom of that molecule).
  [§4](builder-tools.md#4-inputs) has the full list.
- **`DocumentInput`** makes the Builder send a read-only copy of the open
  structure (`OptionalDocumentInput` if the tool also works without one). An
  `insert` tool returns **only the new atoms**, in the document's coordinate
  frame; the Builder appends them.
- **Return a `BuilderResult`.** `Structure.from_arrays(elements, positions,
  cell=..., bonds=...)` takes atomic numbers, Cartesian positions in Å, an
  optional 3×3 cell and optional `(i, j)` bonds. Bond what you know: the
  Builder does not infer bonds for tool results.
- **Raise `ToolError`** for anything the user can fix. The message is shown in
  the form, which stays open with the user's values.
- **Give every required parameter an `examples` value.** The conformance
  checker and LLM clients use it to make a valid call.
- **Long-running tools** can declare `progress: Progress = Progress()` and call
  `progress(fraction, "message")`; the Builder shows it on the form's progress
  bar. Synchronous tools run in a worker thread, so a slow computation does not
  block the server.

`main()` serves the same tools two ways: stdio, which is what LLM clients and
the conformance checker spawn, and Streamable HTTP for the Builder page.
`create_server` and `http_app` are the reference server's own: `http_app` adds
the `Host` / `Origin` checks, CORS for the allowed origins, the bearer token
and `GET /health` that the contract requires of a loopback server
([§9](builder-tools.md#9-trust-and-security)). Keep them; a browser page cannot
call a server without CORS, and a loopback server without a token can be
called by any web page you visit.

## 2. Check it

The conformance checker connects to the server, verifies the tool markers,
form schemas, seeds and document rules, calls every tool with its `examples`,
validates the results, and checks that the same seed gives the same structure
and that bad arguments are refused:

```bash
uv run megane-builder-conformance -- python my_tools.py
```

```text
Server: megane-builder-tools
Builder tools: argon_gas, scatter_atoms
INFO    [argon_gas] sent no progress notifications
INFO    [scatter_atoms] sent no progress notifications
INFO    cancellation is not checked
Result: PASS (0 errors, 0 warnings)
```

It exits non-zero on any error, so it can run in your server's CI.

## 3. Serve it to the Builder

Start the server over HTTP and allow the origin of the page you open the
Builder from (scheme, host and port, no path). For `megane serve --port 8080`
that is `http://localhost:8080`:

```bash
uv run python my_tools.py --http --port 8765 --allow-origin http://localhost:8080
```

It prints `bearer token …`. In the Builder, choose **Tools › Tool server…**,
enter `http://127.0.0.1:8765/mcp` and the token, and press **Connect**. The
menu lists *Argon gas…* under *Bulk* and *Scatter atoms…* under *Other*;
choosing one opens its form, and **Run** builds the structure.

Instead of pasting, open the Builder with the server in its address; it
connects on load and removes the fragment from the address bar:

```text
http://localhost:8080/builder.html#tools=http%3A%2F%2F127.0.0.1%3A8765%2Fmcp&token=<token>
```

The Builder remembers the URL (not the token) and offers it next time. To
check the HTTP endpoint without a browser:

```bash
uv run megane-builder-conformance --url http://127.0.0.1:8765/mcp --token <token>
```

If **Connect** reports *Could not connect*: the token is wrong, the page's
origin is not in `--allow-origin` (the browser console shows a CORS error), or
the server is not running (`curl http://127.0.0.1:8765/health` answers `ok`
when it is).

## 4. Use it from an LLM client

The server stays an ordinary MCP server, so the same file gives an LLM client
the same tools. Each result comes back as `structuredContent` (elements,
positions, cell, bonds) plus a one-line text summary. For Claude Code:

```bash
claude mcp add my-tools -- uv run --directory /path/to/my-tools python my_tools.py
```

Other clients take the common `mcpServers` entry:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/my-tools", "python", "my_tools.py"]
    }
  }
}
```

## Where it works

| Builder host | Tools menu | Your server |
| --- | --- | --- |
| Standalone web app (`megane serve`, a local build, the hosted demo) | ✓ | Streamable HTTP, started by you, with the page's origin allowed (*Tools › Tool server…*) |
| VS Code (1.90+) | ✓ | An entry in the `megane.builder.mcpServers` setting: stdio (VS Code starts it) or Streamable HTTP |
| JupyterLab | ✓ | An entry in `MeganeBuilderTools.mcp_servers` of the Jupyter server's configuration (needs `megane[tools]`): stdio or Streamable HTTP |
| Jupyter widget (`megane.Builder`) | — | — |

In VS Code and JupyterLab the host starts a stdio server itself, so the entry
for this page's server is simply the command:

```json
"my-tools": { "command": "uv", "args": ["run", "--directory", "/path/to/my-tools", "python", "my_tools.py"] }
```

The web app cannot start processes, so there you start the server yourself in
HTTP mode, as above.

## Before you share it

- **Don't serve on anything but loopback without a token.** `http_app` with a
  token is the safe default. `--public`-style serving without a token
  (`http_app(..., token=None)`) is only for a server behind a public demo page,
  together with a call time limit and concurrency cap (`create_server(...,
  limits=CallLimits(timeout=..., max_concurrency=...))`).
- **Keep tools stateless.** The Builder owns the document and sends what a
  tool needs with each call; a server must not remember documents between
  calls.
- **Make the seed decide everything random.** The checker calls a stochastic
  tool twice with the same seed and expects the same structure.
- **Stay within the limits** of [§5.1](builder-tools.md#51-structure): the
  Builder accepts up to 500 000 atoms per result (`MAX_ATOMS` in the SDK),
  positions in Å.
- **Run the checker** against the server you deploy, not only your local copy.
