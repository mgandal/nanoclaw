"""Make scripts/kg importable as a package from these tests."""
import sys
from pathlib import Path

# scripts/ is two levels up from scripts/kg/tests/
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
