# Recall evals

Scores, not gates (docs/SPEC.md section 16). Written by `reverie eval`; see the README for how to run it.

- corpus: reverie-recall-eval v1, 76 memories, 57 questions
- corpus sha256: c032b6c1ba65825a57909d58f770c76f576225138505f0e2b538c9d803f4568e
- recall at: 2026-11-20T12:00:00.000Z
- run on: 2026-11-26
- FTS only: model none, dim none, vector search ran on 0 of 56 recalls that answered
- FTS + reverie-lexical-v1: model reverie-lexical-v1, dim 512, vector search ran on 57 of 57 recalls that answered

Recall at k is the share of a question's expected call numbers in the first k items returned; MRR is the mean of 1 over the rank of the first expected item (0 when none is returned). Abstention precision is the share of abstentions that were right; abstention recall the share of unanswerable questions that abstained. Defaults as shipped: floor 0.35, maxItems 8, tokenBudget 1200, k 60 in the fusion, half-lives fact 365, preference 730, episode 90, reference 365.

## Overall

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| recall@1 | 0.380 | 0.417 |
| recall@3 | 0.725 | 0.768 |
| recall@5 | 0.826 | 0.819 |
| MRR | 0.614 | 0.639 |
| false abstentions | 1 of 46 | 0 of 46 |
| abstention precision | 0.000 | n/a |
| abstention recall | 0.000 | 0.000 |

## extraction (16 questions)

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| recall@1 | 0.313 | 0.313 |
| recall@3 | 0.563 | 0.688 |
| recall@5 | 0.750 | 0.750 |
| MRR | 0.464 | 0.495 |
| false abstentions | 1 of 16 | 0 of 16 |

## multi session (10 questions)

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| recall@1 | 0.150 | 0.117 |
| recall@3 | 0.633 | 0.633 |
| recall@5 | 0.800 | 0.767 |
| MRR | 0.667 | 0.633 |
| false abstentions | 0 of 10 | 0 of 10 |

## temporal (10 questions)

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| recall@1 | 0.500 | 0.500 |
| recall@3 | 0.900 | 0.900 |
| recall@5 | 0.900 | 0.900 |
| MRR | 0.683 | 0.683 |
| false abstentions | 0 of 10 | 0 of 10 |

## knowledge update (10 questions)

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| recall@1 | 0.600 | 0.800 |
| recall@3 | 0.900 | 0.900 |
| recall@5 | 0.900 | 0.900 |
| MRR | 0.733 | 0.833 |
| false abstentions | 0 of 10 | 0 of 10 |

Superseded entry ranked above the current one: FTS only 0, FTS + reverie-lexical-v1 0.

## abstention (11 questions)

|  | FTS only | FTS + reverie-lexical-v1 |
| --- | --- | --- |
| abstention precision | n/a | n/a |
| abstention recall | 0.000 | 0.000 |
