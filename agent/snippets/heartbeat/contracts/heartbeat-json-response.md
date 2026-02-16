Interpret command output:
- If there is at least one newly pulled Discord message with content longer than 2 words, return:
  {"ok": false, "summary": "<concise attention summary>"}
- Otherwise return:
  {"ok": true, "summary": "HEARTBEAT_OK"}

If command fails or Discord is unavailable, do not fabricate results; return:
{"ok": true, "summary": "HEARTBEAT_OK (discord unavailable or no actionable new messages)"}

Return JSON only.
