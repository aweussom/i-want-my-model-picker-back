# TODO

- **Test multiple images.** `set_input_files` accepts a list and the upload
  waiter loops once per file, but `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`
  suggests the app may batch several files into one `UploadFile` call. If it
  does, the per-file wait mis-counts: it would consume one settle signal and
  then sit for 90s waiting for a second that never arrives. Verify before
  claiming multi-image support anywhere.

- Remove the dead `SENTINEL_DONE` constant in `driver.py`.

- Capture the tone enum on a **personal Microsoft account**. Everything
  documented here comes from a work tenant on `licenseType=Starter`; a consumer
  account is a different surface and may not offer `Gpt_5_6_Reasoning` at all.

- `driver.py` has no cancel path into the browser. `/v1/cancel` sets a flag that
  stops the generator, but Copilot keeps generating in the page. Wire it to the
  stop button.

- Conversation reset: the UI's "new chat" button clears its own history but the
  browser keeps the same Copilot thread. Either reload on an empty history or
  expose an explicit endpoint.

- Non-image file uploads. `cwc_fileupload_odb` and `add_filestore_filetype` are
  in `optionsSets`, and `UploadFile` takes a `scenario` field that was
  `UploadImage` for pictures. Something else presumably goes there.
