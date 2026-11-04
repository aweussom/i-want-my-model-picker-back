# archive: the Python API

The first version of the API: Flask (`serve.py`) in front of a Playwright driver
(`driver.py`), plus a launcher (`app.bat`, `app.ps1`) that opened it as a window.

It does not work any more, and it will not run from here as it stands.

- `driver.py` picks the model by opening Copilot's menu and matching entry
  labels. Microsoft renamed the entries to "GPT-5.6 Sol ..." in November 2026,
  so the match fails and requests quietly answer as Auto.
- `driver.py` imports `capture` from the repo root, and the launcher expects
  `serve.py` at the root. Both moved here.

The working API is the Node one in [`../../api`](../../api). It sets the model
by injecting the userscript and writing `tone` into the outgoing frame, and
does not touch the menu.

Kept because the worker-thread design is documented in the main README under
"Playwright's sync API needs the thread inside it", and this is the code that
lesson came from.
