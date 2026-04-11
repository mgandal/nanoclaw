#!/usr/bin/env python3
"""BERTopic clustering + Ollama labeling for paperpile wiki.

Stage 4 of the ingest pipeline. Takes SPECTER2 embeddings (768-dim) from
embedder.py and clusters them into topic groups using BERTopic with UMAP
dimensionality reduction and HDBSCAN density clustering.

Typical usage:
    from clusterer import cluster_papers, assign_noise_to_nearest, assign_new_papers_to_clusters
    topic_model, topics, probs = cluster_papers(abstracts, embeddings)
"""

import re
from typing import Optional

import numpy as np


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

def slugify(text: str) -> str:
    """Convert a topic label to a URL/filename-safe slug.

    Steps:
      1. Lowercase
      2. Strip non-alphanumeric characters (keep spaces and hyphens)
      3. Collapse multiple spaces to a single hyphen
      4. Collapse multiple consecutive hyphens to one
      5. Strip leading/trailing hyphens

    Examples:
        "Autism Genetics & GWAS"          → "autism-genetics-gwas"
        "Single-Cell RNA-Seq (Brain)"     → "single-cell-rna-seq-brain"
        "foo   bar"                       → "foo-bar"

    Args:
        text: Arbitrary topic label string.

    Returns:
        Slugified string safe for filenames and URLs.
    """
    text = text.lower()
    # Strip characters that are not alphanumeric, space, or hyphen
    text = re.sub(r"[^a-z0-9 \-]", "", text)
    # Collapse runs of spaces into a single hyphen
    text = re.sub(r" +", "-", text)
    # Collapse multiple consecutive hyphens into one
    text = re.sub(r"-+", "-", text)
    # Strip leading/trailing hyphens
    text = text.strip("-")
    return text


# ---------------------------------------------------------------------------
# Centroid helpers
# ---------------------------------------------------------------------------

def _compute_centroids(
    embeddings: np.ndarray,
    topics: list,
) -> dict:
    """Compute the mean embedding (centroid) for each cluster.

    Noise points (topic == -1) are excluded.

    Args:
        embeddings: Array of shape (n_papers, embedding_dim).
        topics:     List of integer topic IDs, length n_papers.
                    -1 indicates HDBSCAN noise.

    Returns:
        Dict mapping cluster_id (int) -> centroid (np.ndarray of shape (embedding_dim,)).
        Noise cluster (-1) is never included.
    """
    embeddings = np.asarray(embeddings)
    topics_arr = np.array(topics)
    unique_topics = set(topics_arr.tolist())
    unique_topics.discard(-1)

    centroids = {}
    for topic_id in unique_topics:
        mask = topics_arr == topic_id
        cluster_embeddings = embeddings[mask]
        centroids[int(topic_id)] = cluster_embeddings.mean(axis=0)

    return centroids


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1-D vectors.

    Returns a float in [-1, 1]. Returns 0.0 if either vector has zero norm.
    """
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ---------------------------------------------------------------------------
# Noise reassignment
# ---------------------------------------------------------------------------

def assign_noise_to_nearest(
    topics: list,
    embeddings: np.ndarray,
    centroids: dict,
) -> tuple:
    """Reassign noise papers to their nearest cluster centroid.

    HDBSCAN may label some papers as noise (topic == -1). This function
    assigns each noise paper to the closest cluster centroid using cosine
    similarity. Non-noise papers keep their original assignment with
    confidence 1.0; reassigned noise papers receive the cosine similarity
    as confidence.

    Args:
        topics:     Original topic list from HDBSCAN (length n_papers).
        embeddings: Array of shape (n_papers, embedding_dim).
        centroids:  Dict of cluster_id -> centroid from _compute_centroids().

    Returns:
        (new_topics, confidences)
        - new_topics:   List of int, same length as topics. No -1 values remain
                        if centroids is non-empty.
        - confidences:  List of float, same length. 1.0 for HDBSCAN-assigned
                        papers; cosine similarity (< 1.0 in practice) for noise.
    """
    embeddings = np.asarray(embeddings)
    new_topics = list(topics)
    confidences = []

    # Pre-sort centroid keys for determinism
    centroid_ids = sorted(centroids.keys())

    for i, topic in enumerate(topics):
        if topic != -1:
            confidences.append(1.0)
        else:
            if not centroid_ids:
                # No valid clusters — keep as noise with confidence 0.0
                confidences.append(0.0)
                continue
            # Find nearest centroid by cosine similarity
            best_id = centroid_ids[0]
            best_sim = _cosine_similarity(embeddings[i], centroids[best_id])
            for cid in centroid_ids[1:]:
                sim = _cosine_similarity(embeddings[i], centroids[cid])
                if sim > best_sim:
                    best_sim = sim
                    best_id = cid
            new_topics[i] = best_id
            confidences.append(float(best_sim))

    return new_topics, confidences


# ---------------------------------------------------------------------------
# Incremental assignment for new papers
# ---------------------------------------------------------------------------

def assign_new_papers_to_clusters(
    new_embeddings: np.ndarray,
    centroids: dict,
) -> list:
    """Assign new (unseen) papers to the nearest existing cluster centroid.

    Uses cosine similarity between each paper's embedding and the pre-computed
    cluster centroids.

    Args:
        new_embeddings: Array of shape (n_new_papers, embedding_dim).
        centroids:      Dict of cluster_id -> centroid from _compute_centroids().

    Returns:
        List of (cluster_id, confidence) tuples, one per new paper.
        confidence is the cosine similarity to the assigned centroid (float).
    """
    new_embeddings = np.asarray(new_embeddings)
    if new_embeddings.shape[0] == 0:
        return []

    centroid_ids = sorted(centroids.keys())
    if not centroid_ids:
        return [(0, 0.0)] * len(new_embeddings)

    results = []
    for emb in new_embeddings:
        best_id = centroid_ids[0]
        best_sim = _cosine_similarity(emb, centroids[best_id])
        for cid in centroid_ids[1:]:
            sim = _cosine_similarity(emb, centroids[cid])
            if sim > best_sim:
                best_sim = sim
                best_id = cid
        results.append((int(best_id), float(best_sim)))

    return results


# ---------------------------------------------------------------------------
# BERTopic hierarchy extraction
# ---------------------------------------------------------------------------

def build_hierarchy(topic_model, docs: list) -> list:
    """Extract hierarchical topic relationships from a fitted BERTopic model.

    Args:
        topic_model: A fitted BERTopic instance.
        docs:        List of document strings used for fitting.

    Returns:
        List of dicts, each with keys {"parent_id": int, "child_id": int}.
        Returns [] on any failure.
    """
    try:
        hierarchical_topics = topic_model.hierarchical_topics(docs)
        result = []
        for _, row in hierarchical_topics.iterrows():
            result.append({
                "parent_id": int(row["Parent_ID"]),
                "child_id": int(row["Child_Left_ID"]),
            })
            result.append({
                "parent_id": int(row["Parent_ID"]),
                "child_id": int(row["Child_Right_ID"]),
            })
        return result
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Ollama labeler
# ---------------------------------------------------------------------------

def _get_ollama_labeler():
    """Create a BERTopic OpenAI representation model pointing at Ollama.

    Uses qwen3:8b via the OpenAI-compatible endpoint exposed by Ollama on
    localhost:11434. The prompt requests a concise 3-7 word topic label.

    Returns:
        BertopicOpenAI representation model instance, or None if setup fails.
    """
    try:
        import openai
        from bertopic.representation import OpenAI as BertopicOpenAI

        client = openai.OpenAI(
            base_url="http://localhost:11434/v1",
            api_key="ollama",
        )

        prompt = (
            "I have a topic described by the following keywords: [KEYWORDS]. "
            "Based on the keywords, provide a 3-7 word topic label that "
            "precisely summarizes the theme. Only output the label, nothing else."
        )

        return BertopicOpenAI(
            client,
            model="phi4-mini",  # phi4-mini works via OpenAI endpoint; qwen3:8b returns empty due to thinking mode
            prompt=prompt,
            nr_docs=5,
            delay_in_seconds=0,
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Full BERTopic pipeline
# ---------------------------------------------------------------------------

def cluster_papers(
    abstracts: list,
    embeddings: np.ndarray,
    min_cluster_size: int = 30,
    use_ollama: bool = True,
) -> tuple:
    """Run the full BERTopic clustering pipeline on academic paper abstracts.

    Pipeline:
      1. UMAP for dimensionality reduction (768-dim → 5-dim)
      2. HDBSCAN for density-based clustering
      3. CountVectorizer with bigrams for vocabulary
      4. ClassTfidf for cluster-level term weighting
      5. KeyBERTInspired + optional Ollama (qwen3:8b) for topic labeling

    Args:
        abstracts:        List of abstract strings (one per paper).
        embeddings:       Array of shape (n_papers, 768), pre-computed SPECTER2
                          embeddings.
        min_cluster_size: Minimum papers to form a cluster (HDBSCAN parameter).
                          Default 30.
        use_ollama:       If True, attempt to use the Ollama labeler for richer
                          topic labels. Falls back to keyword labels on failure.

    Returns:
        (topic_model, topics, probs)
        - topic_model: Fitted BERTopic instance.
        - topics:      List of int topic IDs, length n_papers. -1 = noise.
        - probs:       Array of topic probabilities, shape (n_papers,).
    """
    from bertopic import BERTopic
    from sklearn.feature_extraction.text import CountVectorizer
    from bertopic.vectorizers import ClassTfidfTransformer
    from umap import UMAP
    from hdbscan import HDBSCAN

    embeddings = np.asarray(embeddings)

    # --- UMAP ---
    umap_model = UMAP(
        n_neighbors=15,
        n_components=5,
        min_dist=0.0,
        metric="cosine",
        random_state=42,
    )

    # --- HDBSCAN ---
    hdbscan_model = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=10,
        metric="euclidean",
        cluster_selection_method="eom",
        prediction_data=True,
    )

    # --- Vectorizer ---
    vectorizer_model = CountVectorizer(
        stop_words="english",
        ngram_range=(1, 2),
        min_df=5,
    )

    # --- ClassTfidf ---
    ctfidf_model = ClassTfidfTransformer(reduce_frequent_words=True)

    # --- Representation ---
    # Note: KeyBERTInspired requires an embedding model to embed representative
    # docs, but we use pre-computed SPECTER2 embeddings (no embedding_model set
    # on BERTopic). So we skip KeyBERTInspired and use only the Ollama labeler
    # (falling back to c-TF-IDF keywords if Ollama is unavailable).
    representation_model = None
    if use_ollama:
        ollama_labeler = _get_ollama_labeler()
        if ollama_labeler is not None:
            representation_model = ollama_labeler

    # --- BERTopic ---
    topic_model = BERTopic(
        umap_model=umap_model,
        hdbscan_model=hdbscan_model,
        vectorizer_model=vectorizer_model,
        ctfidf_model=ctfidf_model,
        representation_model=representation_model,
        calculate_probabilities=True,
        verbose=True,
    )

    topics, probs = topic_model.fit_transform(abstracts, embeddings)

    return topic_model, topics, probs
