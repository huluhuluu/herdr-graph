# Session Graph user guide

[简体中文](USAGE.zh-CN.md) · [Back to README](../README.md)

## Modes and focus

A **session** is native saved history, a **turn** is a user question and its answer, and the **reader mode** controls the content panel. `t` changes graph scope, `d` changes the Family structure, and `m` changes full/progress reading independently.

| Reader | Content | Updates | Search |
| --- | --- | --- | --- |
| Full output, the default | Complete question and aggregated public answer for the selected turn | c, r, or switching back from changed progress | Loaded full questions and answers in the current graph |
| Live progress | Public assistant messages grouped by question, retaining source order and times | Automatic checks about every 2 seconds while open | Loaded window when the progress reader has focus |

Both readers filter tool content. Progress reads already saved public text, without generating a new model summary or showing thinking, tool parameters or results. Progress/Answer labels require explicit source metadata; other messages remain Assistant.

**Keys depend on focus.** With graph focus, j/k move nodes and g/G select first/last nodes. With content focus they control reading. Tab switches focus, indicated by `[focused]`. Below 96 columns progress uses a full-width reader; Tab returns to the tree. Ordinary full-output details are hidden below 72 columns; Family still offers a full-width reader.

## Common workflows

| Goal | Steps |
| --- | --- |
| Read the current session | Open from an agent pane, then c |
| Follow its running progress | c → m; with content focus, G |
| Find saved history | s → Enter on directory → Enter on session; m also previews its progress directly |
| Read a complete answer | Select a turn, Tab to content; m returns from progress to full output |
| Inspect branches | f on a session, then d for the detailed turn tree |
| Return to the previous page | Backspace/Esc retains filters, folds, reader mode and position |
| Close | q while browsing; Ctrl+C in any mode |

An existing overlay keeps its loaded JavaScript. After an update, close and reopen the overlay; restarting Herdr is unnecessary.

## Current versus selected session

Green `[current]` identifies the current session of the **caller pane that opened the plugin**. It stays on graph nodes beside branch/fork badges, including selected rows. It does not identify the highlighted session or prove a task is working.

Native Herdr session identity takes priority. When absent, agent, directory and full terminal title must match exactly and uniquely. The marker can appear during scanning; later ambiguity removes it. c rechecks the caller and reports unresolved identity without navigating away.

Browsing another session does not move `[current]`. A native resume in the caller also does not silently replace the history being read; press c to open its new current session. Pane identity polls run about every 5 seconds, independently of the 2-second progress checks.

## Live progress

### Following and pausing

- Opening a session header defaults to latest progress. Opening a historical turn locates that turn; a turn without public assistant text is explicitly empty, rather than borrowing a later answer.
- The bottom follows new messages. Scrolling up or searching pauses following and counts new messages; state updates to existing messages do not count as new.
- G/End in the content reader loads the latest window and resumes following. An earlier history request cannot override it.
- m preserves separate full/progress positions. Returning to early history reloads the bookmarked message when needed. Resizing keeps the bookmarked character visible where possible.
- r immediately revalidates the selected log and may rescan that session; it does not scan all history. In full mode, first open a catalog session with Enter, or use m for progress.

Normal checks run about every 2 seconds. Failures back off to about 4/8/16 seconds, capped at 16; r can check earlier. Silence does not prove completion or a stuck task. Task state is shown only when recorded explicitly.

### History and search

The initial window normally contains the latest 200 messages; merged windows contain at most 400. Continue upward at the top to load the previous page, or downward at the bottom to load the next page. This supports reading intermediate history continuously. g requests earliest messages; G requests latest. The window limit does not delete history.

/ in the focused progress reader searches its loaded window without changing graph filters. Page to the desired history before searching. With graph focus, / retains the graph's metadata/full-turn search. p filters all assistant text versus explicitly classified progress; it only changes presentation.

“No classified progress” after p can mean the source lacks reliable classification. Press p to restore all assistant text. Older Codex, Claude and DST records may not provide phases; the last message is never guessed to be a final answer.

### Status messages

| Status | Meaning/action |
| --- | --- |
| Loading progress | Initializing the selected log; large files need one streaming scan |
| Following latest | New messages follow automatically |
| Paused / N new | Reading old content; G in content resumes following |
| No public assistant progress | No displayable public text yet; tool output is filtered |
| No public assistant message … selected turn | The selected turn has no assistant message; return to its full question or use G |
| Sync failed / previous snapshot | The last successful view is retained; check permissions/location or retry with r |
| Log replaced … previous snapshot | Waiting for complete public messages in a replacement log |
| Updating full output | Loading newer full output while retaining the previous snapshot |
| Saved message … no longer available | A rewritten log no longer contains the bookmark; an available window is shown |

Long tool execution, an idle agent starting another task, or a final answer saved after idle do not end the subscription. Leaving progress stops it. Closing the caller pane does not prevent reading existing local files.

## History and branches

s groups history by directory, initially expanding only the caller folder. a cycles agents, v changes directory/time view, o reverses modification-time order, and / searches titles and paths. Counts deduplicate native IDs within each agent and include archived Codex files. Unreadable files retain error entries without aborting other sessions.

f opens the common ancestor and all descendants, including siblings. d switches compact session structure and detailed turns. T toggles source times; h/l fold branches. The detailed tree displays shared history once and preserves native per-session turn numbers. It still loads its turn data while progress content is active.

Connections use native parent IDs; `[turn N]` indexes the direct parent's full transcript. Times use UTC source timestamps, not file modification time as fork time. Missing parents, unknown anchors, loading and read errors are distinct; similar topics never establish a fork.

Enter opens a session header, focuses a detailed Family turn's reader, or jumps from an ordinary full conversation turn to its running pane. Enter in focused progress content returns to full output.

## Resume, fork and rename

| Action | Codex | Claude Code | DST |
| --- | --- | --- | --- |
| n resume | /resume ID | /resume ID | Opens native /resume picker; select manually |
| F fork | Copies the complete saved session, then switches to its child | /branch on the current session | Unavailable |
| R rename | Native App Server name | Native title record and sidecar | Native persistence title event |

Resume/fork use the original caller pane, require the same agent type, idle state and an empty composer, and create no new pane. Sessions already running elsewhere cannot be resumed twice. Codex copies the whole saved history; selecting an early turn changes its preview, not the fork boundary. Claude requires resuming the selected session first and native /branch support.

In rename input Ctrl+U clears, Backspace removes a Unicode character, Enter saves and Esc cancels. Rename starts no model turn. Running native clients may need reopen/resume to show their new title. DST refuses rename while its write lease is held.

Codex initialization and the metadata operation each have a 60-second deadline (up to 120 seconds before helper shutdown). Notifications do not extend either deadline. Forks are submitted once, without automatic retry. A timeout does not prove that no child was saved; inspect native history before repeating the action. The request also defers initial goal continuation on CLI versions supporting `deferGoalContinuation`.

## Key reference

| Key | Graph/browsing | Content/editing |
| --- | --- | --- |
| j/k, arrows | Move nodes | Scroll content |
| PgUp/PgDn | Page by graph height | Scroll 10 lines; progress edges load adjacent history |
| g/G, Home/End | First/last node | Full output: top/bottom; progress: earliest/latest, G follows |
| h/l, left/right | Fold/unfold directory or branch | Not content paging keys |
| Tab, Shift+Tab | Switch graph/content | Full-width reading on narrow Family/progress pages |
| Enter | Expand directory, open session or jump as above | Progress returns to full; editing submits |
| s, c | All history / caller's current session | Literal text while editing |
| m, p, r | Reader mode / progress filter / selected reader refresh | Literal text while editing |
| f, b | Open Family; b is a compatibility alias | Literal text while editing |
| d, T | Family structure/details; source time display | Literal text while editing |
| a, v, o | Agent / directory-time view / sort | Literal text while editing |
| t | session → lineage → all graph scope | Literal text while editing |
| R, n, F | Rename / resume / fork | Literal text while editing |
| / | Search current graph | Focused progress searches its loaded window |
| Ctrl+U, Backspace | Backspace returns a page | Clear input / delete character |
| K, ? | Binding instructions / help | Help scrolls with j/k and PgUp/PgDn |
| Esc | Previous page; closes at root | Cancel input / close help |
| q, Ctrl+C | Close | Ctrl+C closes in any mode; q is text while editing |

## Storage, limits and troubleshooting

Only history accessible on the plugin's machine is read; SSH and local histories are not merged automatically. Storage roots and lifecycle commands are in the [README](../README.md). Installation remembers custom agent roots; explicit environment values win. Overlay startup captures these roots before shell profiles can redirect them.

JSONL records, compressed frames and individual frame decompression have a 64 MiB limit, with visible errors on excess. Older bodies are read by location; complete tool output is not retained in the progress model. Large append bursts prioritize the viewed window and latest messages while leaving all history pageable, and count all new messages rather than only the transferred tail.

| Symptom | Check |
| --- | --- |
| No new progress | Confirm progress mode and target, Paused state, disk persistence and any r error |
| Full output is not continuously changing | Automatic following belongs to progress; use m or explicit c/r |
| Missing current marker | Open from the real agent pane and check native identity; directory/title fallback must be unique |
| Only tools are running | Tool output is filtered; wait for saved public text |
| Wrong session count | Check agent filter, custom roots, archive locations and individual read errors |
| Opening shortcut fails | Check plugin enabled state; try node src/graph.js open; K only explains bindings |
| Old UI after update | Close/reopen the overlay; lifecycle update requires a clean checkout and valid upstream |

clean deletes derived parse caches, not agent history. macOS native execution is still unverified. See [development notes](DEVELOPMENT.md) for implementation details and validation commands.
