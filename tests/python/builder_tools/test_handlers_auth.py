"""The tool bridge's WebSocket refuses users who may not execute code on the server."""

import pytest
from jupyter_server.auth.authorizer import Authorizer
from tornado.httpclient import HTTPClientError


class DenyAll(Authorizer):
    def is_authorized(self, handler, user, action, resource):
        return False


@pytest.fixture
def jp_server_config():
    return {
        "ServerApp": {
            "jpserver_extensions": {"megane.builder_tools": True},
            "authorizer_class": DenyAll,
        }
    }


async def test_refuses_users_who_may_not_execute(jp_serverapp, jp_ws_fetch):
    with pytest.raises(HTTPClientError) as info:
        await jp_ws_fetch("megane", "builder-tools", "ws")
    assert info.value.code == 403
