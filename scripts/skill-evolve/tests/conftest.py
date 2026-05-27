import os
import pytest


@pytest.fixture(autouse=True)
def _anthropic_base_url_for_tests(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://localhost:0/test")
