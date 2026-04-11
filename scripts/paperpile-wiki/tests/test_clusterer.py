#!/usr/bin/env python3
"""Tests for clusterer.py — BERTopic clustering + Ollama labeling."""

import os
import sys
import unittest

import numpy as np

# Allow importing from parent package without installing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from clusterer import (
    slugify,
    _compute_centroids,
    assign_noise_to_nearest,
    assign_new_papers_to_clusters,
)


# ---------------------------------------------------------------------------
# TestSlugify
# ---------------------------------------------------------------------------

class TestSlugify(unittest.TestCase):
    """Tests for the slugify() function."""

    def test_basic_with_ampersand(self):
        """'Autism Genetics & GWAS' → 'autism-genetics-gwas'"""
        self.assertEqual(slugify("Autism Genetics & GWAS"), "autism-genetics-gwas")

    def test_special_chars_parens(self):
        """'Single-Cell RNA-Seq (Brain)' → 'single-cell-rna-seq-brain'"""
        self.assertEqual(slugify("Single-Cell RNA-Seq (Brain)"), "single-cell-rna-seq-brain")

    def test_spaces_collapsed(self):
        """Multiple spaces collapse to single hyphen."""
        self.assertEqual(slugify("foo   bar"), "foo-bar")

    def test_lowercase(self):
        """Output is always lowercase."""
        self.assertEqual(slugify("HELLO WORLD"), "hello-world")

    def test_leading_trailing_hyphens_stripped(self):
        """Leading/trailing hyphens are stripped."""
        self.assertEqual(slugify("  hello world  "), "hello-world")

    def test_multiple_hyphens_collapsed(self):
        """Multiple consecutive hyphens collapse to one."""
        self.assertEqual(slugify("foo--bar"), "foo-bar")

    def test_numbers_preserved(self):
        """Numbers are preserved."""
        self.assertEqual(slugify("Topic 42 Results"), "topic-42-results")

    def test_empty_string(self):
        """Empty string returns empty string."""
        self.assertEqual(slugify(""), "")

    def test_only_special_chars(self):
        """String with only special chars returns empty string."""
        self.assertEqual(slugify("!@#$%^"), "")

    def test_hyphen_preserved(self):
        """Hyphens within words are preserved."""
        self.assertEqual(slugify("well-being"), "well-being")

    def test_mixed_case_hyphen(self):
        """Mixed case with hyphens."""
        self.assertEqual(slugify("RNA-Seq Analysis"), "rna-seq-analysis")


# ---------------------------------------------------------------------------
# TestComputeCentroids
# ---------------------------------------------------------------------------

class TestComputeCentroids(unittest.TestCase):
    """Tests for _compute_centroids()."""

    def test_basic_two_clusters(self):
        """Two clear clusters produce correct mean centroids."""
        embeddings = np.array([
            [1.0, 0.0],
            [2.0, 0.0],
            [0.0, 1.0],
            [0.0, 2.0],
        ], dtype=np.float32)
        topics = [0, 0, 1, 1]
        centroids = _compute_centroids(embeddings, topics)
        self.assertIn(0, centroids)
        self.assertIn(1, centroids)
        np.testing.assert_allclose(centroids[0], [1.5, 0.0])
        np.testing.assert_allclose(centroids[1], [0.0, 1.5])

    def test_noise_excluded(self):
        """Noise points (topic=-1) are excluded from centroid calculation."""
        embeddings = np.array([
            [1.0, 0.0],
            [999.0, 999.0],  # noise point — should not affect centroids
            [0.0, 1.0],
        ], dtype=np.float32)
        topics = [0, -1, 1]
        centroids = _compute_centroids(embeddings, topics)
        self.assertNotIn(-1, centroids)
        self.assertIn(0, centroids)
        self.assertIn(1, centroids)
        np.testing.assert_allclose(centroids[0], [1.0, 0.0])
        np.testing.assert_allclose(centroids[1], [0.0, 1.0])

    def test_single_cluster(self):
        """Single cluster returns its embedding as centroid."""
        embeddings = np.array([[3.0, 4.0]], dtype=np.float32)
        topics = [0]
        centroids = _compute_centroids(embeddings, topics)
        self.assertIn(0, centroids)
        np.testing.assert_allclose(centroids[0], [3.0, 4.0])

    def test_all_noise_returns_empty(self):
        """All noise points returns empty dict."""
        embeddings = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        topics = [-1, -1]
        centroids = _compute_centroids(embeddings, topics)
        self.assertEqual(centroids, {})


# ---------------------------------------------------------------------------
# TestAssignNoiseToNearest
# ---------------------------------------------------------------------------

class TestAssignNoiseToNearest(unittest.TestCase):
    """Tests for assign_noise_to_nearest()."""

    def _make_data(self):
        """5 points: 2 in cluster 0, 2 in cluster 1, 1 noise near cluster 0."""
        # Cluster 0: points near [1, 0, 0]
        # Cluster 1: points near [0, 1, 0]
        # Noise: near cluster 0 (at [0.9, 0.1, 0])
        embeddings = np.array([
            [1.0, 0.0, 0.0],   # cluster 0
            [0.8, 0.0, 0.0],   # cluster 0
            [0.0, 1.0, 0.0],   # cluster 1
            [0.0, 0.9, 0.0],   # cluster 1
            [0.9, 0.1, 0.0],   # noise — closest to cluster 0
        ], dtype=np.float32)
        topics = [0, 0, 1, 1, -1]
        return embeddings, topics

    def test_noise_reassigned(self):
        """Noise point gets reassigned to a valid cluster."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertNotEqual(new_topics[4], -1)

    def test_noise_reassigned_to_correct_cluster(self):
        """Noise point near cluster 0 gets assigned to cluster 0."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertEqual(new_topics[4], 0)

    def test_original_assignments_unchanged(self):
        """Non-noise points keep their original cluster assignments."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertEqual(new_topics[0], 0)
        self.assertEqual(new_topics[1], 0)
        self.assertEqual(new_topics[2], 1)
        self.assertEqual(new_topics[3], 1)

    def test_original_confidence_is_one(self):
        """HDBSCAN-assigned points get confidence 1.0."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        for i in range(4):
            self.assertAlmostEqual(confidences[i], 1.0)

    def test_noise_confidence_less_than_one(self):
        """Noise-reassigned points get confidence < 1.0."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertLess(confidences[4], 1.0)

    def test_no_noise_case(self):
        """When there is no noise, output equals input, all confidences 1.0."""
        embeddings = np.array([
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        ], dtype=np.float32)
        topics = [0, 1]
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertEqual(new_topics, [0, 1])
        self.assertAlmostEqual(confidences[0], 1.0)
        self.assertAlmostEqual(confidences[1], 1.0)

    def test_returns_correct_lengths(self):
        """Output lists have same length as input topics."""
        embeddings, topics = self._make_data()
        centroids = _compute_centroids(embeddings, topics)
        new_topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)
        self.assertEqual(len(new_topics), len(topics))
        self.assertEqual(len(confidences), len(topics))


# ---------------------------------------------------------------------------
# TestAssignNewPapers
# ---------------------------------------------------------------------------

class TestAssignNewPapers(unittest.TestCase):
    """Tests for assign_new_papers_to_clusters()."""

    def _make_centroids(self):
        """3 centroids pointing along each axis."""
        return {
            0: np.array([1.0, 0.0, 0.0], dtype=np.float32),
            1: np.array([0.0, 1.0, 0.0], dtype=np.float32),
            2: np.array([0.0, 0.0, 1.0], dtype=np.float32),
        }

    def test_correct_assignment(self):
        """New papers clearly near different centroids are assigned correctly."""
        centroids = self._make_centroids()
        new_embeddings = np.array([
            [0.95, 0.05, 0.0],  # near centroid 0
            [0.0, 0.1, 0.9],    # near centroid 2
        ], dtype=np.float32)
        results = assign_new_papers_to_clusters(new_embeddings, centroids)
        self.assertEqual(len(results), 2)
        cluster_0, conf_0 = results[0]
        cluster_1, conf_1 = results[1]
        self.assertEqual(cluster_0, 0)
        self.assertEqual(cluster_1, 2)

    def test_returns_list_of_tuples(self):
        """Returns list of (cluster_id, confidence) tuples."""
        centroids = self._make_centroids()
        new_embeddings = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
        results = assign_new_papers_to_clusters(new_embeddings, centroids)
        self.assertIsInstance(results, list)
        self.assertEqual(len(results), 1)
        cluster_id, confidence = results[0]
        self.assertIsInstance(cluster_id, (int, np.integer))
        self.assertIsInstance(confidence, float)

    def test_confidence_between_zero_and_one(self):
        """Confidence values are between 0 and 1."""
        centroids = self._make_centroids()
        new_embeddings = np.array([
            [0.9, 0.1, 0.0],
            [0.1, 0.8, 0.1],
            [0.0, 0.2, 0.8],
        ], dtype=np.float32)
        results = assign_new_papers_to_clusters(new_embeddings, centroids)
        for cluster_id, confidence in results:
            self.assertGreaterEqual(confidence, 0.0)
            self.assertLessEqual(confidence, 1.0)

    def test_empty_embeddings(self):
        """Empty new_embeddings returns empty list."""
        centroids = self._make_centroids()
        new_embeddings = np.zeros((0, 3), dtype=np.float32)
        results = assign_new_papers_to_clusters(new_embeddings, centroids)
        self.assertEqual(results, [])

    def test_perfect_match_high_confidence(self):
        """Embedding identical to centroid gets confidence ~1.0."""
        centroids = self._make_centroids()
        new_embeddings = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
        results = assign_new_papers_to_clusters(new_embeddings, centroids)
        cluster_id, confidence = results[0]
        self.assertEqual(cluster_id, 0)
        self.assertAlmostEqual(confidence, 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
