"""Drift guard: the Python ``Pipeline`` builder covers every TS pipeline node.

The TypeScript pipeline engine is the source of truth for node types, their
ports and their default parameters (``PipelineNodeType`` / ``NODE_PORTS`` /
``defaultParams()`` in ``src/pipeline/types.ts``, ``pythonClass`` in
``src/pipeline/catalog.ts``). Those are exported to
``tests/fixtures/pipeline_node_contract.json`` and the vitest suite
(``tests/ts/pipeline/nodeContractFixture.test.ts``) fails when the fixture goes
stale, so this file can check the Python side without running Node.

A new TS node type therefore fails here until it has a Python class wired into
``Pipeline._build_node_from_dict`` and ``Pipeline._serialize_node`` — which is
what keeps ``Pipeline.from_dict`` able to load any pipeline the webapp saves.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import megane
from megane.pipeline import Pipeline, PipelineNode

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TYPES_TS = REPO_ROOT / "src" / "pipeline" / "types.ts"
CONTRACT_PATH = REPO_ROOT / "tests" / "fixtures" / "pipeline_node_contract.json"

CONTRACT: dict[str, dict] = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

# TS node types with no Python builder class, mapped to the reason. Only for a
# node that genuinely makes no sense outside the browser — keep this empty.
PYTHON_EXCLUDED_NODE_TYPES: dict[str, str] = {}

# TS params a Python node does not carry, so ``from_dict`` → ``to_dict`` drops
# them (the TS deserializer then refills the default). Each entry needs a reason.
PYTHON_OMITTED_PARAMS: dict[str, dict[str, str]] = {}

# Params whose "no file" value is ``null`` in TS but ``""`` in the Python
# path-taking constructors. The TS loaders treat both as "no file opened".
_FILE_NAME_KEYS = {"fileName"}

TS_NODE_TYPES = sorted(CONTRACT)
PY_NODE_TYPES = [t for t in TS_NODE_TYPES if t not in PYTHON_EXCLUDED_NODE_TYPES]


def _parse_ts_node_type_union() -> set[str]:
    source = TYPES_TS.read_text(encoding="utf-8")
    match = re.search(r"export type PipelineNodeType =([^;]*);", source)
    assert match, "PipelineNodeType union not found in src/pipeline/types.ts"
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


def _python_class(node_type: str) -> type[PipelineNode]:
    return getattr(megane, CONTRACT[node_type]["pythonClass"])


def _all_node_subclasses(cls: type) -> list[type]:
    out = []
    for sub in cls.__subclasses__():
        out.append(sub)
        out.extend(_all_node_subclasses(sub))
    return out


def _normalize(key: str, value: object) -> object:
    if key in _FILE_NAME_KEYS and value in (None, ""):
        return None
    return value


def test_contract_fixture_lists_every_ts_node_type():
    """The fixture is not stale relative to the live ``PipelineNodeType`` union."""
    assert set(CONTRACT) == _parse_ts_node_type_union()


def test_exclusion_lists_name_real_ts_entries():
    """Allowlist entries must not outlive the TS node or param they excuse."""
    for node_type in PYTHON_EXCLUDED_NODE_TYPES:
        assert node_type in CONTRACT, f"{node_type} is excluded but no longer a TS node type"
    for node_type, keys in PYTHON_OMITTED_PARAMS.items():
        for key in keys:
            assert key in CONTRACT[node_type]["params"], f"{node_type}.{key} is no longer a TS param"


@pytest.mark.parametrize("node_type", PY_NODE_TYPES)
def test_catalog_python_class_is_exported(node_type):
    """``NODE_CATALOG[type].pythonClass`` names a ``megane`` export of that type."""
    class_name = CONTRACT[node_type]["pythonClass"]
    assert class_name, f"NODE_CATALOG.{node_type}.pythonClass is null"
    assert class_name in megane.__all__
    cls = _python_class(node_type)
    assert issubclass(cls, PipelineNode)
    assert cls._node_type == node_type


@pytest.mark.parametrize("node_type", PY_NODE_TYPES)
def test_python_ports_match_ts_ports(node_type):
    """Python port handles are exactly the TS ``NODE_PORTS`` names."""
    cls = _python_class(node_type)
    assert sorted(cls._inp_ports.values()) == sorted(CONTRACT[node_type]["inputs"])
    assert sorted(cls._out_ports.values()) == sorted(CONTRACT[node_type]["outputs"])


@pytest.mark.parametrize("node_type", PY_NODE_TYPES)
def test_ts_default_params_round_trip(node_type):
    """A node saved by the webapp with TS defaults survives from_dict → to_dict."""
    params = CONTRACT[node_type]["params"]
    node_id = f"{node_type}-1"
    pipeline = {
        "version": 3,
        "nodes": [{"id": node_id, "position": {"x": 0, "y": 0}, **params}],
        "edges": [],
    }
    out = next(n for n in Pipeline.from_dict(pipeline).to_dict()["nodes"] if n["id"] == node_id)

    assert out["type"] == node_type
    omitted = PYTHON_OMITTED_PARAMS.get(node_type, {})
    for key, value in params.items():
        if key == "type" or key in omitted:
            continue
        assert key in out, f"Python drops {node_type}.{key} on round trip"
        assert _normalize(key, out[key]) == _normalize(key, value), f"{node_type}.{key}"


def test_from_dict_without_params_matches_ts_defaults():
    """A node dict carrying only id/type gets the TS ``defaultParams()`` values."""
    nodes = [{"id": f"{t}-1", "type": t} for t in PY_NODE_TYPES]
    built = Pipeline.from_dict({"version": 3, "nodes": nodes, "edges": []}).to_dict()
    by_id = {n["id"]: n for n in built["nodes"]}
    for node_type in PY_NODE_TYPES:
        out = by_id[f"{node_type}-1"]
        omitted = PYTHON_OMITTED_PARAMS.get(node_type, {})
        for key, value in CONTRACT[node_type]["params"].items():
            if key == "type" or key in omitted:
                continue
            assert _normalize(key, out.get(key)) == _normalize(key, value), f"{node_type}.{key}"


def test_every_python_node_class_is_a_ts_node_type():
    """No Python node class serializes a ``type`` the TS engine does not know."""
    for cls in _all_node_subclasses(PipelineNode):
        assert cls._node_type in CONTRACT, f"{cls.__name__}._node_type={cls._node_type!r}"
