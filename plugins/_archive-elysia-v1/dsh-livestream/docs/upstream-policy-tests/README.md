# Upstream policy test originals

These `.ts.txt` files preserve the official imported tests byte for byte. See
`../../UPSTREAM.json` for the upstream revision and Git blob provenance.

The runnable counterparts keep the upstream body, stage, game handoff and UI
contracts, while adapting these policy boundaries:

- attention is FIFO with bounded UTF-8 pages and original native-session references;
- no keyword scoring chooses meaning, people or responses, and no age threshold discards input;
- native DSH session records preserve complete decoded protocol input, stable projection intents and inbox identity;
- an idle timer is a voluntary attention window, including the choice to pass;
- no separate viewer/persona memory database, automatic distillation or forgetting is mounted;
- speech success requires fixture audio and a real stage `ended` receipt. Null audio,
  missing speakers, cancellation and timeouts are failures, not successful speech.

These copies are evidence of the upstream policy delta, not an excluded replacement
suite. The updated runnable tests live in `../../test/` and are collected normally.
