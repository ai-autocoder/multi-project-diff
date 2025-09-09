# Change Log

## [2.0.1]

- Fixed an issue where refreshing the diff would fail if there was no active editor.

## [2.0.0]

### New Features

- Watch Mode toggle in the view toolbar to automatically use the active editor file as reference and refresh diffs on focus change.
- Pin action on each file row to set that file as the reference for comparison.
- Toolbar action to set the currently active editor file as the reference.
- Clicking the reference file row re-runs the comparison against the current reference file (no longer resets to the active file).

### Improvements

- Performance: Multicore diffing with worker_threads. Per-workspace diff tasks now run in a worker pool, keeping the extension host responsive and delivering 3-4x speedups on medium/large files across multiple projects.
- Performance: Add mtime-based LRU diff cache (with reverse lookups) to avoid re-diffing unchanged pairs.
- Reorganized inline button order for a more consistent experience.
- Dedicated Activity Bar container with the `arrow-swap` codicon for quicker access.
- Improved progress indication using VS Code's built-in view-scoped progress bar.
- Prevent running diffs on ineligible tabs: ignore VS Code diff/non-text/virtual tabs and skip very large (>2MB) or binary-like files; manual action now warns when the active tab isn't a single file.
- Performance: Replace jsdiff with an optimized counts-only exact diff (tokenized +
  trimmed), significantly speeding up large-file comparisons.
- Updated README for new features.

## [1.2.0]

- Add "Open Terminal" button in diff view
- Display "Open Folder" button for missing files, in addition to existing files
- Minor bug fixes and improvements

## [1.1.2]

- Fix relative path when reference file is outside the current workspace

## [1.1.1]

- Fix screenshot image in README

## [1.1.0]

- Fix wrong path used for copy command when changing editor focus.
- Prevent path case sensitivity issues.
- Update command titles to be more descriptive.
- Update readme.
- Code cleanup.

## [1.0.0]

- Initial release
