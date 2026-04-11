#!/usr/bin/env python3
"""SPECTER2 embedding for academic papers.

Uses the `adapters` library to load allenai/specter2_base with the
proximity adapter. Produces 768-dim float32 embeddings stored as raw
bytes blobs suitable for SQLite BLOBs.

Typical usage:
    from embedder import embed_papers
    results = embed_papers(papers)  # {paper_id: bytes}
"""

import struct
from typing import Union

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EMBEDDING_DIM = 768
BATCH_SIZE = 32
MODEL_NAME = "allenai/specter2_base"
ADAPTER_NAME = "allenai/specter2"


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def embedding_to_bytes(vec: Union[list, "np.ndarray"]) -> bytes:
    """Convert a float vector to a raw float32 bytes blob for SQLite.

    Args:
        vec: A list of floats or a numpy array of any float dtype.

    Returns:
        Raw bytes: len(vec) * 4 bytes (float32, native byte order).
    """
    if isinstance(vec, np.ndarray):
        return vec.astype(np.float32).tobytes()
    return struct.pack(f"{len(vec)}f", *vec)


def bytes_to_embedding(blob: bytes) -> list:
    """Deserialise a float32 bytes blob back to a list of Python floats.

    Args:
        blob: Raw bytes produced by ``embedding_to_bytes``.

    Returns:
        List of float values (length = len(blob) // 4).
    """
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def _load_model():
    """Load SPECTER2 base model with proximity adapter.

    Downloads ~420 MB on first call; adapter is ~3.4 MB.

    Returns:
        (tokenizer, model, device) tuple ready for inference.
    """
    import torch
    from transformers import AutoTokenizer
    from adapters import AutoAdapterModel

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoAdapterModel.from_pretrained(MODEL_NAME)
    model.load_adapter(ADAPTER_NAME, source="hf", load_as="proximity", set_active=True)
    model.eval()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = model.to(device)
    return tokenizer, model, device


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_papers(papers: list, batch_size: int = BATCH_SIZE) -> dict:
    """Embed a list of paper dicts using SPECTER2.

    Each paper is formatted as ``title [SEP] abstract`` (or title only if
    the abstract is missing/empty). The CLS token (position 0) of the
    final hidden state is used as the paper representation.

    Args:
        papers:     List of dicts. Required key: ``id``, ``title``.
                    Optional key: ``abstract`` (str or None).
        batch_size: Number of papers to encode in each forward pass.

    Returns:
        Dict mapping paper_id (str) -> embedding bytes (3072 bytes each).
    """
    import torch

    tokenizer, model, device = _load_model()

    results = {}
    total_batches = (len(papers) + batch_size - 1) // batch_size

    for batch_idx in range(0, len(papers), batch_size):
        batch = papers[batch_idx: batch_idx + batch_size]
        current_batch_num = batch_idx // batch_size + 1

        # Format input texts
        texts = []
        for p in batch:
            title = p.get("title") or ""
            abstract = p.get("abstract") or ""
            if abstract:
                text = title + tokenizer.sep_token + abstract
            else:
                text = title
            texts.append(text)

        # Tokenise
        inputs = tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        inputs = {k: v.to(device) for k, v in inputs.items()}

        # Forward pass
        with torch.no_grad():
            output = model(**inputs)

        # CLS token embeddings (position 0)
        cls_embeddings = output.last_hidden_state[:, 0, :]  # (batch, 768)
        cls_embeddings = cls_embeddings.cpu().numpy()

        for paper, emb_vec in zip(batch, cls_embeddings):
            results[paper["id"]] = embedding_to_bytes(emb_vec)

        if current_batch_num % 10 == 0 or current_batch_num == total_batches:
            processed = min(batch_idx + batch_size, len(papers))
            print(
                "Embedded {}/{} papers (batch {}/{})".format(
                    processed, len(papers), current_batch_num, total_batches
                )
            )

    return results
