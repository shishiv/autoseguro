# API replay hybrid evidence

Label: **API-emulated hybrid**.

This proves the real AutoSeguro webhook, core, durable intake/outbox, real Ollama Cloud DeepSeek V4 Flash, and the unmodified official quote service worked together through a loopback Meta Graph capture peer.

It does not prove Meta accepted the requests or how a phone rendered them. No real WhatsApp client or Meta endpoint received a message.

| Conversation | Terminal outcome | Elapsed ms | Quote attempts |
|---|---|---:|---:|
| essencial-csat | closed | 1600 | 1 |
| completo-reselect | resolved | 1439 | 1 |
| premium-pro-rata | resolved | 3422 | 1 |
| slow-status-success | resolved | 9481 | 1 |
| five-xx-handoff | handoff | 3757 | 3 |

Each result JSON records ordered synthetic turns, presence, outbound payload shapes, quote attempts, terminal state, and semantic contracts. `payload-shape-provenance.json` records the accepted source shapes and hashes.
