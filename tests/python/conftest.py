"""Shared pytest setup.

``pytest_jupyter.jupyter_server`` provides the Jupyter server fixtures
(``jp_serverapp``, ``jp_ws_fetch``, …) for the Builder tool bridge's server
extension tests, and runs ``async def`` tests on an asyncio loop.
"""

pytest_plugins = ["pytest_jupyter.jupyter_server"]
