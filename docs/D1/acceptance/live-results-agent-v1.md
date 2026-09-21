# Live acceptance results (agent-v1, claude-sonnet-5)

Generated from the evidence directories `.mia-state/live/2026-09-17T14-32-41-305Z` and `.mia-state/live/2026-09-17T14-35-16-556Z` (private; the second reran five scenarios after harness fixes). 20/20 rows passed. Lane L = live runtime; ledger evidence from the controlled fixture. "reported effort: unverified" means the turn used no tool, so the PreToolUse hook produced no effort evidence.

| scenario | repeat | pass | conversation | reported model | reported effort | runtime | ledger commits | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| allow-policy-no-prompt | 1 | pass | conv_de6d2462a7064c0789f4c18fd6d7a25f | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| allow-policy-no-prompt | 2 | pass | conv_2fc6af562ecc40d9b23e083901778f86 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| allowed | 1 | pass | conv_ad5492a809984fdd89bc5054be0c7b0e | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| allowed | 2 | pass | conv_f524fa4f26164d6187087efc6234acd4 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| approve-reject | 1 | pass | conv_2043043fae0a431d85f7862287e69b0c | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| approve-reject | 2 | pass | conv_1c66d739f7de4afd8f3d9c3f6d829df9 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| artifact-export | 1 | pass | conv_8e4a0e02286c471ab3953cbc5b3a8179 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | artifact | All assertions passed |
| artifact-export | 2 | pass | conv_455c44617a074c14827af45ae1dc75ce | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | artifact | All assertions passed |
| cancellable | 1 | pass | conv_bc7679ac790b43f49d4a55b132854824 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| cancellable | 2 | pass | conv_b6378a3c77e44941be83f8ae78ff96aa | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| denied | 1 | pass | conv_081cc47f9c3e419c81695b502ff5bdf0 | claude-sonnet-5 | unverified | 2.1.274 (Claude Code) | none | All assertions passed |
| denied | 2 | pass | conv_9eeb9abee0714f1fa80136623e90c863 | claude-sonnet-5 | unverified | 2.1.274 (Claude Code) | none | All assertions passed |
| every-call | 1 | pass | conv_7e67061f87c44ebc884eac1a3ee07c30 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| every-call | 2 | pass | conv_255dfb1ee1674bad9fdd2920f70277fe | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
| silence-disconnect | 1 | pass | conv_3298a56bb6a343d7a10c59ba08129429 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| silence-disconnect | 2 | pass | conv_6007240e7d5d4204a28c26b7bb035510 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | none | All assertions passed |
| stream-context | 1 | pass | conv_2d35eb12495a41ee9adaa34b2dceb6b2 | claude-sonnet-5 | unverified | 2.1.274 (Claude Code) | none | All assertions passed |
| stream-context | 2 | pass | conv_37d2d3d440144435aee753cb2fc02998 | claude-sonnet-5 | unverified | 2.1.274 (Claude Code) | none | All assertions passed |
| uncancellable | 1 | pass | conv_5030253e5e1f47908390d68c8821c969 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | slow | All assertions passed |
| uncancellable | 2 | pass | conv_a7a3263534d54c2c90c56b2b33ccb8a6 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | slow | All assertions passed |

Post-review regression check (after the engine rewrite and review fixes), one repeat:

| scenario | repeat | pass | conversation | reported model | reported effort | runtime | ledger commits | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| approve-reject | 1 | pass | conv_04193749be8e43cabca64d7cdf0a4931 | claude-sonnet-5 | medium | 2.1.274 (Claude Code) | change | All assertions passed |
