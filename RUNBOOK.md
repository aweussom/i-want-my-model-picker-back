# Runbook: aider on Copilot

How I run aider against a Copilot work account through the API in `api/`. The API drives a signed-in browser and passes each request to Copilot as a new chat. Aider sees an OpenAI-compatible endpoint and does not know the difference.

Measured 2026-11-25 on the work tenant, one run each:

- Small multi-turn task with a hidden test file: 16 of 16 checks in 2 turns, 50 s on `Gpt_5_6_Reasoning`, 55 s on `Gpt_62_Sol_Reasoning`.
- A real fix in another repo, 64k character prompt: 1 turn, 70 s, its checks passed.

## Start

Sign in once per profile (`npm run signin`, see [api/README.md](api/README.md)). Then, from `api/`:

```powershell
$env:COPILOT_HISTORY = 'full'
npm run serve
```

`COPILOT_HISTORY=full` is required for aider. Without it the API sends only the last user message, and aider's system prompt and file contents never reach the model. With it, every request is flattened into one prompt and sent as a new, empty chat.

Check it is up and which menu it read:

```powershell
curl.exe -s http://127.0.0.1:8791/health
curl.exe -s http://127.0.0.1:8791/v1/models
```

`menuFrom` in `/health` says `page <time>` when the model menu was read from the page on this start, `cache <time>` when it fell back to an earlier read.

In the repo you want to work in:

```powershell
$env:OPENAI_API_KEY = 'unused-local'
aider --model openai/Gpt_62_Sol_Reasoning --weak-model openai/Gpt_62_Sol_Reasoning `
  --openai-api-base http://127.0.0.1:8791/v1 `
  --model-metadata-file <path to this repo>\api\aider.model.metadata.json `
  --max-chat-history-tokens 8192 `
  --edit-format diff --commit-language english
```

Add `--test-cmd "<your tests>" --auto-test` and aider feeds failures back to the model until they pass.

## Why the flags

- `--model-metadata-file`: aider does not know the tone names. Without a context size it sets its history limit to 1024 tokens, and after nearly every turn it asks the weak model for a summary. With `--message` the process has exited by the time the answer arrives (aider issue #3700), so each one is a Copilot chat thrown away. The file says 30000 input tokens, from the 128k character composer limit at about 4 characters per token. The 16000 output tokens is a guess.
- `--max-chat-history-tokens 8192`: keeps the flattened prompt well under that limit.
- `--edit-format diff`: SEARCH/REPLACE blocks. Worked on every run.
- `--commit-language english`: without it the commit messages came back in Norwegian.

## Models

The model name aider sends must be in the menu Copilot shows this account, as listed by `/v1/models`. Anything else gets a 400 with the list. It no longer falls back to the default. A model marked `gated` (Claude on the work tenant) needs a tenant policy the script cannot check, and it is refused with `model_gated`.

When the menu changes, use the new name from `/v1/models` in `--model` and add an entry for it to `api/aider.model.metadata.json`.

## Limits and known trouble

- The composer takes at most 128,000 characters. Larger prompts get a 400 `context_length_exceeded`. Drop files from the aider chat.
- Copilot HTML-escapes tag-like text on the way in (`<b>` arrives as `&lt;b&gt;`). The API's preamble tells the model to write real brackets. That fixed it in four of four quote checks, a small sample.
- Every request leaves a chat in the account's Copilot history. The server logs each one's id to `api/.api-chats.jsonl`. To delete them, stop the server and run `node src/cleanup-tests.js --api-chats --dry-run` from `api/`, then again without `--dry-run`. Copilot titles these chats itself, so the tool goes by id, not title.
- Aider shows 0 tokens sent and received. The API reports no usage.
- After a crash or `taskkill /T`, a headless Chrome can keep holding the profile and the next start fails with "No usable browser". Find it and stop it:

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'i-want-my-model-picker-back' } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate }
  ```

- A running server keeps the code it started with. After pulling, restart it. A server started before 6.2 support answered with GPT-5.6 while aider asked for 6.2. It would now refuse the name, but restart anyway.
