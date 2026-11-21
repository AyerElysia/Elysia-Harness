# Local tokenizer assets

These are public static tokenizer files for `deepseek-ai/DeepSeek-V4.1-Flash`, pinned to Hugging Face commit `314113f8a7dadb388215396ba5fbee2c610a04d6`. The model repository identifies their license as MIT; the original LICENSE is retained beside the files. No model weights or model-repository Python code were downloaded or executed.

Source metadata: https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash . Each asset's immutable resolve URL, expected size, SHA-256 and Git blob SHA-1 is retained in `deepseek-v4.1-flash/manifest.json`. The downloaded bytes matched both hashes.

| File | Bytes | SHA-256 |
|---|---:|---|
| tokenizer.json | 6367257 | `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b` |
| tokenizer_config.json | 801 | `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547` |
| LICENSE | 1084 | `f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040` |

## Runtime implementation

`@huggingface/tokenizers@0.2.0` is the zero-runtime-dependency pure JavaScript tokenizer published by Hugging Face under Apache-2.0. Exact registry metadata: https://registry.npmjs.org/@huggingface%2Ftokenizers/0.2.0 . Source repository: https://github.com/huggingface/tokenizers.js .

The tarball's SHA-512 integrity is `sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==`. Its registry SHA-1 and integrity were checked before extraction. Only this package was extracted into the plugin's ignored node_modules; no package lifecycle scripts, workspace installation or dependency build ran. The runtime package's original LICENSE remains in that installed package.

## Encoding API

`new Tokenizer(tokenizerJson, tokenizerConfig).encode(text, { add_special_tokens: false }).ids.length` counts text without automatic special-token insertion. Version 0.2.0's EncodeOptions has no padding or truncation options; callers must not pass invented flags. Both fields in these pinned tokenizer.json bytes are null. Empty input returns zero ids; this version's decode rejects an empty id array.

The source files parse as BPE with Sequence normalization/pre-tokenization and ByteLevel post-processing. Public Chinese, English, JSON and emoji fixture ids matched the already installed native Hugging Face tokenizers 0.22.2 implementation with special insertion, padding and truncation disabled. A 41,984-byte public repeated-text fixture produced 9,216 tokens and decoded without truncation. Full public inputs and results are in `deepseek-v4.1-flash/validation.json`.

This validation used Node 22.20.0. One recorded run took approximately 66 ms to read/parse the assets and 158 ms to construct the tokenizer; 400 short encoding calls averaged 0.011 ms and the longer fixture took 13 ms. These are one-run observations, not performance guarantees.

## Scope

This is a local text BPE count, not provider-reported usage. It does not by itself serialize a chat template, roles, tools, images or provider transport. A third-party model alias is not proof that the upstream uses these exact vocabulary and framing bytes. Keep route/revision and counting method visible, preserve a declared estimate fallback, and do not label this result as an exact server count. JavaScript/native parity is checked only for the retained public fixtures; unsupported regular-expression behavior can differ.

The smoke used no private prompt, credential, model API or platform-message request.
