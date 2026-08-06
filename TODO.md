# TODO

- **Test multiple images.** `set_input_files` accepts a list and the upload
  waiter loops once per file, but `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`
  suggests the app may batch several files into one `UploadFile` call. If it
  does, the per-file wait mis-counts: it would consume one settle signal and
  then sit for 90s waiting for a second that never arrives. Verify before
  claiming multi-image support anywhere.

- Remove the dead `SENTINEL_DONE` constant in `driver.py`.

- **A personal Microsoft account cannot reach this surface at all.** Signing into
  `m365.cloud.microsoft/chat` with a free consumer account returns "Oppgrader
  Microsoft 365 til a bruke Copilot Chat" -- an upsell wall. So the plan of
  reproducing everything on a personal account, to keep a work tenant out of it,
  is closed unless you buy a Microsoft 365 subscription. Everything documented
  here therefore comes from one work tenant on `licenseType=Starter`.

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
