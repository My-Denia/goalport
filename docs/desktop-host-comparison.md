# Electron and Tauri candidate comparison

Both candidates use the same React bundle, Core protocol, Core executable, SQLite schema and RuntimeManager. Only the host bridge differs. The final comparison ran the required step order on the same Windows machine, shared synthetic database, Core `b063fa…4376fb`, prompt and input hashes. Every sample was captured after the final packages were built.

| Item | Electron 44.0.0 | Tauri 2.11.x / WebView2 151 | Result |
| --- | --- | --- | --- |
| Final artifact | packaged `GoalPort.exe` directory | release EXE plus MSI/NSIS | both runnable |
| Core hash | `b063fa…4376fb` in resources | `b063fa…4376fb` adjacent/bundled | identical |
| Connected native flow | project → Campaign/Task → Codex tool/reply/terminal | same | PASS both |
| Chinese IME | real compositionstart/update/end, committed `测试中文` | same | PASS both |
| System clipboard | 9,200 chars / 10,800 bytes, SHA-256 `f3af34…c4b891` | same | PASS both |
| Long history/tool rows | 85 events; scroll and screenshot; separate 72-event tool/permission turn | same shared Core data | PASS both |
| Campaign switch | original → secondary → original → secondary | same | PASS both |
| UI close/reopen | detached Core and Codex PIDs survive; current Attempt/cursor unchanged | same shared Core | PASS both; no prompt replay |
| Host tree RSS, one post-reopen sample | 4 processes, 393,375,744 bytes | host + 6 WebView2 processes, 477,671,424 bytes | Electron ~84MB lower on this sample |
| Distribution size | main EXE 244,440,576 bytes plus resources | EXE 8,440,832 bytes; NSIS 3,161,147 bytes; MSI 4,599,808 bytes | Tauri much smaller |
| Notification | GUI Send invokes Electron `Notification`; visible toast was not retained as evidence | no notification bridge | Electron partial; Tauri not implemented |

The RSS result is one machine/sample and includes renderer/WebView children. The shared Core used 9,125,888 bytes and the native Codex CLI 164,024,320 bytes; both are reported separately rather than assigned to either host. It is not a general benchmark. Idle CPU rounded to 0% in this sample.

**Recommendation:** Electron is the sole main release line. Tauri remains a bounded regression candidate after shared Core/protocol change, not a second product. Dual-host compare is skipped for this Stable V1 run (`desktop-compare-skipped.json`). Process samples, if captured, use this-run Electron only.

Evidence: `evidence/windows-interactions/*final-b063*`, `process-final-b063.json`, and `desktop-compare.json`. The verifier binds all required step IDs, order, timestamps, final artifact hashes, identical inputs, shared prompt/Core data, reopen identity and process attribution. Notification remains `UNMET_NOTIFICATION`.

