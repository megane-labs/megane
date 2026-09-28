"""`import megane` must not import the Jupyter widget stack.

The widget pulls in anywidget -> ipywidgets -> IPython, which roughly doubles
the time and memory `import megane` costs. The CLI, the server and scripts that
only read or write structures never use it, so ``megane.MolecularViewer`` is
resolved on first access instead.
"""

import subprocess
import sys

import pytest

import megane
import megane.widget


def _run(code: str) -> str:
    return subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout.strip()


def test_import_megane_does_not_load_the_widget_stack():
    loaded = _run(
        "import sys, megane; "
        "print(sorted(m for m in ('megane.widget', 'anywidget', 'ipywidgets', 'IPython') "
        "if m in sys.modules))"
    )
    assert loaded == "[]"


def test_molecular_viewer_is_importable_from_the_package():
    assert _run("from megane import MolecularViewer; print(MolecularViewer.__module__)") == "megane.widget"
    assert _run("from megane import *; print(MolecularViewer.__name__)") == "MolecularViewer"


def test_dir_lists_the_widget_before_it_is_imported():
    assert _run("import sys, megane; print('MolecularViewer' in dir(megane), 'megane.widget' in sys.modules)") == (
        "True False"
    )
    assert "MolecularViewer" in dir(megane)
    assert "load_pdb" in dir(megane)


def test_getattr_resolves_and_caches_the_widget_class():
    assert megane.__getattr__("MolecularViewer") is megane.widget.MolecularViewer
    assert vars(megane)["MolecularViewer"] is megane.widget.MolecularViewer
    assert megane.MolecularViewer is megane.widget.MolecularViewer


def test_unknown_attributes_still_raise():
    with pytest.raises(AttributeError, match="no attribute 'not_a_megane_name'"):
        megane.not_a_megane_name  # noqa: B018
