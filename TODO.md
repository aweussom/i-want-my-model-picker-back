# TODO

- **Test multiple images.** `set_input_files` accepts a list and the upload
  waiter loops once per file, but `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`
  suggests the app may batch several files into one `UploadFile` call. If it
  does, the per-file wait mis-counts: it would consume one settle signal and
  then sit for 90s waiting for a second that never arrives. Verify before
  claiming multi-image support anywhere.

- Remove the dead `SENTINEL_DONE` constant in `driver.py`.

- **Whether a free personal account can reach this surface is unresolved.** It
  showed an upsell wall ("Oppgrader Microsoft 365 til a bruke Copilot Chat") on one
  sign-in and worked on the next, with nothing bought in between and only the three
  generic tones offered. Rollout, experiment bucket or transient failure all fit two
  observations. Settle it by reading `licenseType` from `GET /health` on that
  account after sending one message, and record the answer here.

  Worth doing because it decides the provenance question: if a personal account
  works, everything documented here can be reproduced without involving an
  employer's tenant.

- Untested: whether any of this applies to the consumer product at
  `copilot.microsoft.com`. It is a different backend, so `tone` may not exist
  there at all. That is a separate investigation, and possibly a better one to
  publish from.

- `driver.py` has no cancel path into the browser. `/v1/cancel` sets a flag that
  stops the generator, but Copilot keeps generating in the page. Wire it to the
  stop button.

- Conversation reset: the UI's "new chat" button clears its own history but the
  browser keeps the same Copilot thread. Either reload on an empty history or
  expose an explicit endpoint.

- Non-image file uploads. `cwc_fileupload_odb` and `add_filestore_filetype` are
  in `optionsSets`, and `UploadFile` takes a `scenario` field that was
  `UploadImage` for pictures. Something else presumably goes there.

- **The conversation list falls back to the DOM, so it is impoverished.**
  `GetConversationPageHistoryList` returns nothing for every payload shape tried:
  `{action}` alone, plus `enableLastMessage`/`conversationHistoryFilter`, plus a
  minimal `state`. The real client also sends `syncState`, a cursor we have no
  copy of, and that is the likely requirement. Consequences of the fallback: no
  tone, no preview, no timestamp, and only what the sidebar has rendered -- the
  count varies between 18 and 36 as it lazy-loads. Fix by capturing a live
  `syncState` from a real request and mirroring it.

- Testing against a real account leaves litter. `src/cleanup-tests.js` deletes it
  (`--dry-run` first). Deletion goes through the sidebar overflow menu, whose items
  are localised: "Gi nytt navn", "Legg til i notatblokk", "Slett". Prefer a
  throwaway prompt you can recognise later over "hi".
