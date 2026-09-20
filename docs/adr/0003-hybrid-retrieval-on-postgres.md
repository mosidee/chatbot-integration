# 0003 — Hybrid retrieval on Postgres, and why `word_similarity`

Date: 2026-09-20
Status: accepted

## Context

Retrieval has to work for Thai and English, and has to find two different kinds of thing: an
answer phrased nothing like the question, and a literal string such as a plan code or an
order reference. Dense vectors handle the first and are poor at the second.

The plan assumed a keyword half built on `pg_trgm`. That assumption was measured before
anything was built on it.

## Measurements

Against Postgres 16 with `pg_trgm`, comparing a short query to a longer chunk:

| Case | `similarity` | `word_similarity` |
|---|---|---|
| Thai question against its own answer | 0.058 | 0.333 |
| Thai question against an unrelated answer | 0.013 | 0.059 |
| Thai term present in the document | 0.091 | 0.571 |
| Thai term absent | 0.000 | 0.000 |
| English question against its own answer | 0.096 | 0.182 |
| English question against an unrelated answer | 0.027 | 0.053 |
| Exact plan code | 0.235 | 1.000 |

`similarity` compares whole strings, so a short query against a long chunk always scores
near zero. Every value above sits below the default `pg_trgm` threshold of 0.3, meaning the
`%` operator would have matched nothing at all. It is the wrong function for this shape of
query.

`word_similarity` scores the best matching run inside the chunk. It separates relevant from
irrelevant by roughly 5x on Thai and 3x on English, returns exactly 1.0 for an exact code,
and 0 when the term is absent.

A GIN index with `gin_trgm_ops` is used for Thai: `EXPLAIN` on 20,000 rows shows a bitmap
index scan on the `%>` operator, not a sequential scan.

One caveat the numbers make clear: `SO-1234` scores 0.375 against a query for `SO-8891`,
because they share trigrams. That is higher than a genuinely relevant Thai match at 0.333.
A single global threshold cannot separate every case, which is why fusion, not thresholding,
decides the final order.

## Decision

Two halves, fused:

- **Dense**: cosine distance over pgvector with an HNSW index.
- **Keyword**: `word_similarity(query, text)` with the `<%` operator over a GIN trigram
  index.

Each half applies a floor **before** fusion. A half that found only weak matches contributes
nothing rather than contributing its least-bad member at rank 1. Reciprocal rank fusion then
merges what survives, with ties broken by id inside each list as well as after fusion, so
identical queries cannot return results in a different order.

`retrieve()` returns the dense list, the keyword list and the fused list separately. When
retrieval regresses the question is always "did dense miss it, or did keyword drown it?",
and a single fused list cannot answer that.

Embeddings are 1024 dimensions: native for bge-m3, and reachable for OpenAI's
text-embedding-3 models through the `dimensions` parameter.

## Consequences

- No separate search service. One Postgres holds conversations, knowledge and vectors.
- A dead embedding provider degrades retrieval to keyword-only rather than failing the
  customer's turn.
- Chunks are stored even when no embedding provider is configured, so keyword retrieval
  works from the first upload and a later re-index fills the vectors in.
- The floors are tuned for production models. The test suite passes lower ones, because its
  deterministic embedding has a different score distribution.
- Changing the embedding dimension means a migration and a re-index. Re-indexing is already
  a normal operation in the knowledge screen.
