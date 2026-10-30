# Second Brain Auto Linker 🧠🔗

A powerful Obsidian plugin that turns your vault into a dynamic, self-organizing neural network. Instead of manually linking notes, this plugin automatically discovers and connects concepts across your entire vault.

## ✨ Features

- **Context-Aware Linking**: Intelligently skips code blocks, frontmatter properties, URLs, and existing links to prevent data corruption.
- **Alias Support**: Seamlessly reads your Obsidian aliases (via `metadataCache`). If you have a note named `Artificial Intelligence` with an alias `AI`, it will link both terms while preserving your specific display text.
- **Length Guardrails**: Skips 1- or 2-letter words automatically to prevent unintended chaotic links (e.g., linking every "it" or "to").
- **Safe API Usage**: Uses Obsidian's native `Vault.process()` to ensure zero data loss, even if files are syncing in the background.

## 🛠️ How to Use

Once installed and enabled, you have three native ways to interact with the plugin:

### 1. The Global Scan Button (Left Ribbon)
Look at the far left edge of your Obsidian window (the vertical strip).
- **Icon**: A **network graph** icon.
- **Action**: Click to trigger a massive global scan. It silently catalogs all your note titles and aliases, searches your entire vault, and turns matching plain text into hyperlinks.

### 2. The Right-Click Editor Menu (Surgical Precision)
Highlight text directly inside your notes to create instant connections.
- **Propagate an existing link**: Highlight a link like `[[Cybernetics]]`, right-click, and select **Propagate link 'Cybernetics' vault-wide**. 
- **Propagate raw text**: Highlight any plain text word (3+ letters), right-click, and select **Link text '...' to active note vault-wide**. This connects the raw text everywhere in your vault back to the note you currently have open.

### 3. The Command Palette (Keyboard Friendly)
Press **Ctrl/Cmd + P** to open the Obsidian Command Palette and type "Propagate" or "Scan" to find:
- `Global Scan: Auto-link all note titles and aliases vault-wide`
- `Propagate current note's title and aliases vault-wide`

## ⚙️ Manual Installation

1. Download the plugin files or build them from source.
2. Place the compiled `main.js`, `manifest.json`, and this `README.md` into your vault's plugin folder: `YourVault/.obsidian/plugins/second-brain-auto-linker/`.
3. Restart Obsidian.
4. Go to **Settings > Community Plugins**, disable Safe Mode, and toggle on **Second Brain Auto Linker**.
