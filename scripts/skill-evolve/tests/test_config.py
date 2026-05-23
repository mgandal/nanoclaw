from pathlib import Path
from skill_evolve import config


def test_repo_root_resolves_to_nanoclaw():
    assert config.REPO_ROOT.name == "nanoclaw"
    assert (config.REPO_ROOT / "container" / "skills" / "wiki" / "SKILL.md").exists()


def test_wiki_skill_paths():
    assert config.wiki_skill_path() == config.REPO_ROOT / "container" / "skills" / "wiki" / "SKILL.md"
    assert config.wiki_conventions_path() == config.REPO_ROOT / "container" / "skills" / "wiki" / "CONVENTIONS.md"


def test_load_anthropic_base_url_from_env(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("ANTHROPIC_BASE_URL=http://localhost:9999\n")
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    url = config.load_anthropic_base_url()
    assert url == "http://localhost:9999"


def test_load_anthropic_base_url_missing_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    import pytest
    with pytest.raises(RuntimeError, match="ANTHROPIC_BASE_URL not set"):
        config.load_anthropic_base_url()
