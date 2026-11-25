# TODO

Open work. Approaches already tried and rejected are in [TODONT.md](TODONT.md);
read that before proposing anything structural.

- **Confirm the Turnstile wall on the free consumer surface is permanent.** One
  afternoon's evidence only. If it is a rollout rather than a policy, the free
  account becomes the right place to develop against — no work tenant, no audit
  log — and the README's Security section should say so outright rather than
  hedging. Re-test with `probe_tone.py --await-human` and a human at the keyboard.

- **The picker path is gone, before the Turnstile question was settled.** On
  2026-11-04 the API (`api/src/driver.js`) switched to forcing `tone` through the
  injected userscript and stopped clicking the menu, against the earlier note here
  to wait. On the work tenant that is observed fine: two live turns, no challenge,
  the tone confirmed on the wire. On a surface that challenges every send, clicking
  was the only thing that proved a human was present, and that argument still
  stands there. Settle it on the free surface before recommending the API for it.

- **`diff_frames.py` draws a wrong conclusion on identical captures.** When two
  captures match it prints "Model selection is NOT carried in the chat
  invocation. Look for a separate settings call" — which is the right hint when
  comparing two *different* picker settings, and actively misleading when
  comparing a picker-selected turn against a force-injected one, where identical
  is the desired result. Guard the message on whether the two inputs were meant
  to differ.

- **Test multiple images.** `set_input_files` accepts a list and the upload
  waiter loops once per file, but `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`
  suggests the app may batch several files into one `UploadFile` call. If it
  does, the per-file wait mis-counts: it would consume one settle signal and
  then sit for 90s waiting for a second that never arrives. Verify before
  claiming multi-image support anywhere.

- Untested: whether any of this applies to the consumer product at
  `copilot.microsoft.com`. It is a different backend, so `tone` may not exist
  there at all. That is a separate investigation, and possibly a better one to
  publish from.

- `api/src/driver.js` has no cancel path into the browser. `/v1/cancel` sets a flag that
  stops the generator, but Copilot keeps generating in the page. Wire it to the
  stop button.

- Conversation reset: the UI's "new chat" button clears its own history but the
  browser keeps the same Copilot thread. Either reload on an empty history or
  expose an explicit endpoint.

- **Attachments and OneDrive files as context, for a real coding harness.** Not
  needed for aider: the composer takes 128,000 characters and a 119,980-character
  prompt came back with all three needles [OBSERVED 2026-11-25, probe-limits.js
  and one real send]. A harness like Claude Code or OpenCode needs more: its
  system prompt and tool definitions alone can exceed 128k characters (Claude
  Code's auto-mode classifier prompt is ~47,800 tokens). The split to test:
  static text (system prompt, tool docs, CLAUDE.md, reference files) as an
  attachment or OneDrive file; tool-call protocol, history, tool results and
  edited files typed. Two tests decide it:
  1. Needles at start, middle and end of a ~300k-character attachment, and of
     the same file attached from OneDrive. Does the model name all three, or
     does Copilot hand it retrieved fragments? Fragments kill the idea for
     instructions, silently.
  2. OneDrive only: change the last needle, ask again at once, time how long
     until the answer changes. A stale copy means edits against old content.
  Keep the tool-call format in typed text whatever the result; that is what the
  bridge parses. Prefer OpenCode as the target: its prompts are config
  [INFERRED, not checked for the current version].

- Non-image file uploads. `cwc_fileupload_odb` and `add_filestore_filetype` are
  in `optionsSets`, and `UploadFile` takes a `scenario` field that was
  `UploadImage` for pictures. Something else presumably goes there.

- Testing against a real account leaves litter. `src/cleanup-tests.js` deletes it
  (`--dry-run` first). Deletion goes through the sidebar overflow menu, whose items
  are localised: "Gi nytt navn", "Legg til i notatblokk", "Slett". Prefer a
  throwaway prompt you can recognise later over "hi".

- What does the server do with a named tone the account does not have? The API
  no longer discovers per-account tones, so a free consumer account (generic
  modes only, per TODONT.md) gets asked for `Gpt_5_6_Reasoning` too. A bogus tone
  is refused with `NotFound` on the tenant (probe_tone.py, 2026-09-15), so a
  refusal is likely, but a silent downgrade would not be visible. Needs the
  Turnstile question above answered first.

- `run_probe.py` selects by menu label and has not been rerun since the
  "GPT-5.6 Sol" rename of 2026-11-04.

- Aider leaves one Copilot chat per request (RUNBOOK.md). `cleanup-tests.js`
  does not match them; their titles come from the API preamble ("You are serving
  as the model behind an API..."). Add that pattern, dry-run first.

- `aider-full-history` is not merged to main. Use it on real work for a while
  first, then merge, and point api/README.md at RUNBOOK.md.

- The default is the bottom entry of the GPT submenu. If Microsoft adds a cheaper
  model last, it becomes the default without an error. A log line when the
  default is not in TONES would at least show it.
