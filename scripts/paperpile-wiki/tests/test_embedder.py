#!/usr/bin/env python3
"""Tests for embedder.py — SPECTER2 embedding layer."""

import os
import sys
import struct
import unittest

# Allow importing from parent package without installing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

from embedder import (
    EMBEDDING_DIM,
    embedding_to_bytes,
    bytes_to_embedding,
)


# ---------------------------------------------------------------------------
# Embedding conversion tests (no model required)
# ---------------------------------------------------------------------------

class TestEmbeddingConversion(unittest.TestCase):
    """Round-trip tests for embedding_to_bytes / bytes_to_embedding."""

    def _make_vec(self, dim=768):
        """Build a deterministic list of floats."""
        import math
        return [math.sin(i * 0.01) for i in range(dim)]

    def test_round_trip_list(self):
        """List[float] → bytes → List[float] preserves values to 5 decimal places."""
        vec = self._make_vec()
        blob = embedding_to_bytes(vec)
        recovered = bytes_to_embedding(blob)
        self.assertEqual(len(recovered), EMBEDDING_DIM)
        for orig, rec in zip(vec, recovered):
            self.assertAlmostEqual(orig, rec, places=5)

    def test_byte_count(self):
        """768 float32s should produce exactly 3072 bytes."""
        vec = self._make_vec()
        blob = embedding_to_bytes(vec)
        self.assertEqual(len(blob), EMBEDDING_DIM * 4)
        self.assertEqual(len(blob), 3072)

    def test_round_trip_numpy(self):
        """numpy array → bytes → List[float] preserves values to 5 decimal places."""
        if not HAS_NUMPY:
            self.skipTest("numpy not installed")
        import numpy as np
        vec = np.array(self._make_vec(), dtype=np.float64)
        blob = embedding_to_bytes(vec)
        recovered = bytes_to_embedding(blob)
        self.assertEqual(len(recovered), EMBEDDING_DIM)
        for orig, rec in zip(vec, recovered):
            self.assertAlmostEqual(float(orig), rec, places=5)

    def test_bytes_to_embedding_length(self):
        """bytes_to_embedding on a 3072-byte blob returns a 768-element list."""
        blob = struct.pack(f"{EMBEDDING_DIM}f", *([0.0] * EMBEDDING_DIM))
        result = bytes_to_embedding(blob)
        self.assertEqual(len(result), EMBEDDING_DIM)

    def test_embedding_to_bytes_returns_bytes(self):
        """embedding_to_bytes always returns bytes."""
        vec = self._make_vec()
        blob = embedding_to_bytes(vec)
        self.assertIsInstance(blob, bytes)

    def test_bytes_to_embedding_returns_list(self):
        """bytes_to_embedding always returns a list."""
        blob = struct.pack(f"{EMBEDDING_DIM}f", *([1.0] * EMBEDDING_DIM))
        result = bytes_to_embedding(blob)
        self.assertIsInstance(result, list)

    def test_round_trip_numpy_float32(self):
        """numpy float32 array survives round-trip without precision loss."""
        if not HAS_NUMPY:
            self.skipTest("numpy not installed")
        import numpy as np
        vec = np.random.rand(EMBEDDING_DIM).astype(np.float32)
        blob = embedding_to_bytes(vec)
        recovered = bytes_to_embedding(blob)
        for orig, rec in zip(vec, recovered):
            self.assertAlmostEqual(float(orig), rec, places=5)


# ---------------------------------------------------------------------------
# embed_papers tests (model required — skip if deps or model unavailable)
# ---------------------------------------------------------------------------

class TestEmbedPapers(unittest.TestCase):
    """Integration tests for embed_papers — skip if model not available."""

    _model_available = None  # cached across test methods

    @classmethod
    def _check_model(cls):
        """Return True if the SPECTER2 model can be loaded."""
        if cls._model_available is not None:
            return cls._model_available
        try:
            from transformers import AutoTokenizer
            from adapters import AutoAdapterModel  # noqa: F401
            import torch  # noqa: F401
            cls._model_available = True
        except (ImportError, OSError):
            cls._model_available = False
        return cls._model_available

    def setUp(self):
        if not self._check_model():
            self.skipTest("SPECTER2 model dependencies not available")

    def test_embed_returns_dict_with_correct_ids(self):
        """embed_papers returns a dict keyed by paper_id."""
        try:
            from embedder import embed_papers
        except (ImportError, OSError) as exc:
            self.skipTest(f"embed_papers unavailable: {exc}")

        papers = [
            {"id": "p1", "title": "Neural networks in genomics", "abstract": "We study neural nets."},
            {"id": "p2", "title": "CRISPR-Cas9 editing", "abstract": "Genome editing via CRISPR."},
        ]
        try:
            result = embed_papers(papers, batch_size=2)
        except (ImportError, OSError) as exc:
            self.skipTest(f"Model not downloaded: {exc}")

        self.assertIn("p1", result)
        self.assertIn("p2", result)
        self.assertEqual(len(result), 2)

    def test_embed_correct_byte_length(self):
        """Each embedding blob is exactly 768 * 4 = 3072 bytes."""
        try:
            from embedder import embed_papers
        except (ImportError, OSError) as exc:
            self.skipTest(f"embed_papers unavailable: {exc}")

        papers = [
            {"id": "p1", "title": "Attention is all you need", "abstract": "Transformer architecture."},
        ]
        try:
            result = embed_papers(papers, batch_size=1)
        except (ImportError, OSError) as exc:
            self.skipTest(f"Model not downloaded: {exc}")

        self.assertEqual(len(result["p1"]), EMBEDDING_DIM * 4)

    def test_embed_missing_abstract(self):
        """Papers with None or empty abstract embed using title only."""
        try:
            from embedder import embed_papers
        except (ImportError, OSError) as exc:
            self.skipTest(f"embed_papers unavailable: {exc}")

        papers = [
            {"id": "no_abstract", "title": "A paper with no abstract", "abstract": None},
            {"id": "empty_abstract", "title": "A paper with empty abstract", "abstract": ""},
        ]
        try:
            result = embed_papers(papers, batch_size=2)
        except (ImportError, OSError) as exc:
            self.skipTest(f"Model not downloaded: {exc}")

        self.assertIn("no_abstract", result)
        self.assertIn("empty_abstract", result)
        self.assertEqual(len(result["no_abstract"]), EMBEDDING_DIM * 4)
        self.assertEqual(len(result["empty_abstract"]), EMBEDDING_DIM * 4)

    def test_embed_missing_abstract_key(self):
        """Papers where 'abstract' key is entirely absent embed successfully."""
        try:
            from embedder import embed_papers
        except (ImportError, OSError) as exc:
            self.skipTest(f"embed_papers unavailable: {exc}")

        papers = [
            {"id": "no_key", "title": "Title only paper"},
        ]
        try:
            result = embed_papers(papers, batch_size=1)
        except (ImportError, OSError) as exc:
            self.skipTest(f"Model not downloaded: {exc}")

        self.assertIn("no_key", result)
        self.assertEqual(len(result["no_key"]), EMBEDDING_DIM * 4)


if __name__ == "__main__":
    unittest.main()
