<div align="center">

<img src="https://github.com/ai-autocoder/multi-project-diff/blob/main/icon.png?raw=true" width="200" alt="Logo">

</div>

<h1 align="center" style="margin: 2rem auto 1rem;">
Multi Projects Diff
</h1>

<h3 align="center" style="margin: 0 auto 1rem;">The project diff tool for VS Code.</h3>

<p align="center">
 <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.multi-projects-diff">
 <img src="https://vsmarketplacebadges.dev/version/FrancescoAnzalone.multi-projects-diff.png?label=Multi%20Project%20Diff" alt="Marketplace badge"></a>
</p>

Compare the currently open file in the editor against corresponding files in other project paths (within the same configured group).

![Image of UI overview](screenshot1.png)

## Features

1. **Project Diff View:** A dedicated view in the Explorer sidebar lists all projects within the matched group for the current file, enabling quick comparison.

2. **Flexible Reference File Selection:**
    *   **Set as Reference:** Use the inline "Set as Reference" action (pin icon) on any file in the list to make it the reference for comparison.
    *   **Use Active File as Reference:** Use the view toolbar action "Use Active File as Reference" (target icon) to set the currently active editor file as the reference.

3. **Clear Diff Indicators:** Project items are clearly labeled with the project name and the number of added/removed lines (`[Project Name] ([Added Lines]/[Removed Lines])`). A "File Missing" indicator is shown if the file doesn't exist in a particular project.

4. **One-Click Actions:**
    *   **Open Split-Screen Diff:** Click on a project item to open a split-screen diff comparing the reference file with the selected project's file.
    *   **Push Content from Reference:** Copy the content of the reference file to the selected project's file.
    *   **Create and Push File:** Create a missing file in a selected project and copy the content from the reference file.
    *   **Open File:** Opens the file from a selected project in a new editor tab.
    *   **Open Workspace:** Opens the workspace folder of a selected project in a new VS Code window.
    *   **Open Terminal:** Opens a terminal in the selected project's folder.

5. **Group Selection:** If the current file doesn't belong to any defined group, or if you want to compare against a different group, use the "Pick Group" button to choose a specific group for comparison (only available if the file doesn't belong to any group).

## How to Use

1.  **Open a file** you want to use for comparison. This becomes the initial reference file the first time you run the diff.
2.  Open the **"MULTI PROJECTS DIFF"** view in the Explorer sidebar. The view will show the comparison of your active file against other projects in the same group.
3.  **Change the Reference File (Optional):**
    *   Click **Set as Reference** (pin icon) next to any file in the list to set it as the new reference for all comparisons.
    *   Click **Use Active File as Reference** (target icon) in the toolbar to set the file currently active in your editor as the reference.
4.  **Refresh Comparison:** Click **Refresh** (refresh icon) at the top of the view to re-run the diff against the current reference file. Refresh does not change the reference file.
5.  **View Diffs:** Click on any project item in the list to open a split-screen diff.

If the file belongs to a configured group, the view automatically displays the diff results against the other projects in that group.

If the file doesn't belong to any group, or if you want to compare against a specific group, use **Pick Group** to select a group.

## Configuration

Configure the extension by defining "diff groups" in your VS Code settings (`settings.json`). Each group contains a name, an optional `ignoreWhiteSpace` setting, and an array of "workspaces" (projects).

```jsonc
// Config example
{
  "multiProjectsDiff.diffGroups": [
    {
      "name": "My Project Group",
      "ignoreWhiteSpace": true,
      "workspaces": [
        {
          "name": "Project Alpha",
          "path": "/path/to/project/alpha"
        },
        {
          "name": "Project Beta",
          "path": "/path/to/project/beta"
        },
        {
          "name": "Project Gamma",
          "path": "/path/to/project/gamma"
        },
        {
          "name": "Project Delta",
          "path": "/path/to/project/delta"
        }
      ]
    },
    {
      "name": "Another Group",
      "workspaces": [
        {
          "name": "Project Epsilon",
          "path": "/path/to/project/epsilon"
        }
      ]
    }
  ]
}
```

## Contributing

Contributions are welcome!  Please submit pull requests or bug reports.

## License

This extension is licensed under the MIT License.
