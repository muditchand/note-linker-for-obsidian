import { App, Plugin, PluginSettingTab, Setting, Modal, Notice, TFile } from 'obsidian';

interface SearchTerm {
    term: string;
    link: string;
}

interface AutoLinkerSettings {
    minTermLength: number;
    onlyFirstOccurrence: boolean;
    preventSelfLinking: boolean;
    excludedFolders: string;
    requireConfirmation: boolean;
    showRibbonIcon: boolean;
}

const DEFAULT_SETTINGS: AutoLinkerSettings = {
    minTermLength: 3,
    onlyFirstOccurrence: true,
    preventSelfLinking: true,
    excludedFolders: '',
    requireConfirmation: true,
    showRibbonIcon: true,
};

export default class AutoLinkerPlugin extends Plugin {
    settings!: AutoLinkerSettings;
    // In-memory snapshot of the last batch edit, keyed by file path, so it can be reverted.
    lastOperationSnapshot: Map<string, string> | null = null;

    async onload() {
        console.log('Loading Neuron Auto Linker');
        await this.loadSettings();

        // 1. Global Vault Scan Command
        this.addCommand({
            id: 'scan-vault-global-links',
            name: 'Global Scan: Auto-link all note titles and aliases vault-wide',
            callback: () => this.runGlobalScan()
        });

        // 2. Local File Scan Command (propagate this note's title/aliases)
        this.addCommand({
            id: 'propagate-current-note-links',
            name: "Propagate current note's title and aliases vault-wide",
            callback: () => this.runLocalFileScan()
        });

        // 3. Undo Command — safety net for the batch edits above
        this.addCommand({
            id: 'undo-last-autolink',
            name: 'Undo last Auto-Link operation',
            callback: () => this.undoLastOperation()
        });

        // 4. Ribbon Icon for 1-click Global Scan
        if (this.settings.showRibbonIcon) {
            this.addRibbonIcon('network', 'Auto-Link Vault (Global Scan)', () => {
                this.runGlobalScan();
            });
        }

        // 5. Editor Context Menu for Right-Click Fuzzy-ish Propagation
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                const selection = editor.getSelection().trim();
                if (!selection) return;

                const linkMatch = selection.match(/^\[\[(.*?)\]\]$/);

                if (linkMatch && linkMatch[1]) {
                    const innerText = linkMatch[1];
                    let target: string = innerText;
                    let display: string = innerText;

                    if (innerText.includes('|')) {
                        const parts = innerText.split('|');
                        target = parts[0] || innerText;
                        display = parts[1] || innerText;
                    }

                    menu.addItem((item) => {
                        item
                            .setTitle(`Propagate link '${display}' vault-wide`)
                            .setIcon('link')
                            .onClick(async () => {
                                await this.scanAndLinkVault([{ term: display, link: target }]);
                            });
                    });
                } else if (selection.length >= this.settings.minTermLength) {
                    menu.addItem((item) => {
                        item
                            .setTitle(`Link text '${selection}' to active note vault-wide`)
                            .setIcon('link')
                            .onClick(async () => {
                                const targetNote = view?.file;
                                if (targetNote) {
                                    await this.scanAndLinkVault([{ term: selection, link: targetNote.basename }]);
                                } else {
                                    new Notice('No active note to link this text to.');
                                }
                            });
                    });
                }
            })
        );

        this.addSettingTab(new AutoLinkerSettingTab(this.app, this));
    }

    onunload() {
        console.log('Unloading Neuron Auto Linker');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ---------- Entry points ----------

    async runGlobalScan() {
        const terms = this.buildGlobalSearchTerms();
        if (terms.length === 0) {
            new Notice('No note titles or aliases met the minimum length — nothing to scan for.');
            return;
        }
        await this.scanAndLinkVault(terms);
    }

    async runLocalFileScan() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No active file to propagate.');
            return;
        }

        const terms: SearchTerm[] = [];
        const baseName = activeFile.basename;
        if (baseName.length >= this.settings.minTermLength) {
            terms.push({ term: baseName, link: baseName });
        }

        const cache = this.app.metadataCache.getFileCache(activeFile);
        if (cache?.frontmatter?.aliases) {
            const aliases = Array.isArray(cache.frontmatter.aliases)
                ? cache.frontmatter.aliases
                : [cache.frontmatter.aliases];

            for (const alias of aliases) {
                if (alias && alias.toString().length >= this.settings.minTermLength) {
                    terms.push({ term: alias.toString(), link: baseName });
                }
            }
        }

        if (terms.length === 0) {
            new Notice('Active note\'s title is too short and it has no usable aliases.');
            return;
        }

        await this.scanAndLinkVault(terms);
    }

    // ---------- Term collection ----------

    buildGlobalSearchTerms(): SearchTerm[] {
        const terms: SearchTerm[] = [];
        const files = this.getScannableFiles();

        for (const file of files) {
            const baseName = file.basename;
            if (baseName.length >= this.settings.minTermLength) {
                terms.push({ term: baseName, link: baseName });
            }

            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.aliases) {
                const aliases = Array.isArray(cache.frontmatter.aliases)
                    ? cache.frontmatter.aliases
                    : [cache.frontmatter.aliases];

                for (const alias of aliases) {
                    if (alias && alias.toString().length >= this.settings.minTermLength) {
                        terms.push({ term: alias.toString(), link: baseName });
                    }
                }
            }
        }

        const uniqueTerms = new Map<string, SearchTerm>();
        for (const term of terms) {
            const lowerTerm = term.term.toLowerCase();
            if (!uniqueTerms.has(lowerTerm)) {
                uniqueTerms.set(lowerTerm, term);
            }
        }

        return Array.from(uniqueTerms.values());
    }

    getScannableFiles(): TFile[] {
        const excluded = this.settings.excludedFolders
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (excluded.length === 0) {
            return this.app.vault.getMarkdownFiles();
        }

        return this.app.vault.getMarkdownFiles().filter(f =>
            !excluded.some(folder => f.path === folder || f.path.startsWith(folder.endsWith('/') ? folder : folder + '/'))
        );
    }

    // ---------- Core scan / link / apply flow ----------

    async scanAndLinkVault(searchTerms: SearchTerm[]) {
        if (searchTerms.length === 0) {
            new Notice('No linkable terms provided.');
            return;
        }

        const files = this.getScannableFiles();
        if (files.length === 0) {
            new Notice('No markdown files to scan (check your excluded folders in settings).');
            return;
        }

        const statusNotice = new Notice(`Scanning ${files.length} note(s)...`, 0);

        // Longest terms first so e.g. "Project Alpha" wins over just "Alpha".
        const sortedTerms = [...searchTerms].sort((a, b) => b.term.length - a.term.length);

        const termMapGlobal = new Map<string, string>();
        sortedTerms.forEach(t => termMapGlobal.set(t.term.toLowerCase(), t.link));

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = sortedTerms.map(t => escapeRegExp(t.term)).join('|');
        const searchRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');

        const pendingChanges = new Map<TFile, { oldContent: string; newContent: string }>();
        let scanned = 0;

        for (const file of files) {
            scanned++;
            if (scanned % 25 === 0) {
                statusNotice.setMessage(`Scanning note ${scanned} of ${files.length}...`);
            }

            const content = await this.app.vault.cachedRead(file);
            const termMap = this.settings.preventSelfLinking
                ? this.stripSelfLinks(termMapGlobal, file.basename)
                : termMapGlobal;

            const newContent = this.replaceTextPreservingFormatting(
                content,
                searchRegex,
                termMap,
                this.settings.onlyFirstOccurrence
            );

            if (newContent !== content) {
                pendingChanges.set(file, { oldContent: content, newContent });
            }
        }

        statusNotice.hide();

        if (pendingChanges.size === 0) {
            new Notice('Scan complete — no new connections found.');
            return;
        }

        const totalFiles = pendingChanges.size;

        const applyChanges = async () => {
            const snapshot = new Map<string, string>();
            for (const [file, change] of pendingChanges) {
                snapshot.set(file.path, change.oldContent);
                await this.app.vault.modify(file, change.newContent);
            }
            this.lastOperationSnapshot = snapshot;
            new Notice(
                `Auto-Link complete! Updated ${totalFiles} note(s). Run "Undo last Auto-Link operation" to revert.`,
                6000
            );
        };

        if (this.settings.requireConfirmation) {
            new ConfirmModal(
                this.app,
                'Confirm Auto-Link',
                `Found new connections to add in ${totalFiles} note(s) out of ${files.length} scanned. ` +
                'This will edit those notes directly (you can undo it right after with the "Undo last Auto-Link operation" command). Continue?',
                applyChanges
            ).open();
        } else {
            await applyChanges();
        }
    }

    async undoLastOperation() {
        if (!this.lastOperationSnapshot || this.lastOperationSnapshot.size === 0) {
            new Notice('No previous Auto-Link operation to undo (undo history clears on Obsidian restart).');
            return;
        }

        const snapshot = this.lastOperationSnapshot;
        let restored = 0;

        for (const [path, oldContent] of snapshot) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.app.vault.modify(file, oldContent);
                restored++;
            }
        }

        this.lastOperationSnapshot = null;
        new Notice(`Undo complete. Restored ${restored} note(s) to their previous state.`);
    }

    // ---------- Text transformation ----------

    stripSelfLinks(termMap: Map<string, string>, basename: string): Map<string, string> {
        const baseLower = basename.toLowerCase();
        const filtered = new Map<string, string>();
        for (const [term, link] of termMap) {
            if (link.toLowerCase() !== baseLower) {
                filtered.set(term, link);
            }
        }
        return filtered;
    }

    replaceTextPreservingFormatting(
        text: string,
        searchRegex: RegExp,
        termMap: Map<string, string>,
        onlyFirstOccurrence: boolean
    ): string {
        // Anything matched here (frontmatter, code blocks, inline code, math, existing
        // wiki-links, existing markdown links) is left completely untouched.
        const regexTokens = /(^---\r?\n[\s\S]*?\r?\n---)|(```[\s\S]*?```)|(`[^`\n]+`)|(\$\$[\s\S]*?\$\$)|(\$[^$\n]+\$)|(\[\[.*?\]\])|(\[.*?\]\(.*?\))/g;

        const parts: { type: 'text' | 'ignore'; content: string }[] = [];
        let lastIndex = 0;
        let match;

        while ((match = regexTokens.exec(text)) !== null) {
            parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
            parts.push({ type: 'ignore', content: match[0] });
            lastIndex = regexTokens.lastIndex;
        }
        parts.push({ type: 'text', content: text.slice(lastIndex) });

        const usedLinks = new Set<string>();

        // Notes already linked elsewhere in this file (even before this run) count as
        // "already connected" so we don't pepper the note with repeat links.
        if (onlyFirstOccurrence) {
            const wikiLinkRegex = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;
            for (const part of parts) {
                if (part.type !== 'ignore') continue;
                let m;
                wikiLinkRegex.lastIndex = 0;
                while ((m = wikiLinkRegex.exec(part.content)) !== null) {
                    usedLinks.add(m[1].trim().toLowerCase());
                }
            }
        }

        for (const part of parts) {
            if (part.type !== 'text') continue;
            part.content = part.content.replace(searchRegex, (matchStr) => {
                const linkTarget = termMap.get(matchStr.toLowerCase());
                if (!linkTarget) return matchStr;

                const key = linkTarget.toLowerCase();
                if (onlyFirstOccurrence && usedLinks.has(key)) {
                    return matchStr;
                }
                usedLinks.add(key);

                return key === matchStr.toLowerCase()
                    ? `[[${linkTarget}]]`
                    : `[[${linkTarget}|${matchStr}]]`;
            });
        }

        return parts.map(p => p.content).join('');
    }
}

// ---------- UI: Settings tab ----------

class AutoLinkerSettingTab extends PluginSettingTab {
    plugin: AutoLinkerPlugin;

    constructor(app: App, plugin: AutoLinkerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Neuron Auto Linker' });
        containerEl.createEl('p', {
            text: 'These settings control how aggressively the plugin turns plain text into links across your vault.'
        });

        new Setting(containerEl)
            .setName('Minimum term length')
            .setDesc('Note titles or aliases shorter than this are ignored, so short/common words never get auto-linked.')
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.minTermLength))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.minTermLength = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Only link first occurrence per note')
            .setDesc('Each target note is linked at most once per file, instead of turning every single mention into a link.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.onlyFirstOccurrence)
                .onChange(async (value) => {
                    this.plugin.settings.onlyFirstOccurrence = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Prevent self-linking')
            .setDesc("Stops a note from linking to itself when its own title or alias appears in its own body text.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.preventSelfLinking)
                .onChange(async (value) => {
                    this.plugin.settings.preventSelfLinking = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Confirm before applying changes')
            .setDesc('Show a summary of how many notes will change and ask before anything is edited.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.requireConfirmation)
                .onChange(async (value) => {
                    this.plugin.settings.requireConfirmation = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Excluded folders')
            .setDesc('Comma-separated folder paths to fully skip — these notes are never scanned and never linked to. Example: Templates, Daily Notes')
            .addText(text => text
                .setPlaceholder('Templates, Daily Notes')
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show ribbon icon')
            .setDesc('Show the sidebar icon for one-click Global Scan. Restart Obsidian after changing this.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showRibbonIcon)
                .onChange(async (value) => {
                    this.plugin.settings.showRibbonIcon = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Commands' });
        const list = containerEl.createEl('ul');
        list.createEl('li', { text: 'Global Scan: scans your whole vault using every note title and alias as a possible link.' });
        list.createEl('li', { text: "Propagate current note's title and aliases vault-wide: only uses the active note's own title/aliases." });
        list.createEl('li', { text: 'Undo last Auto-Link operation: reverts the most recent batch of changes (cleared on restart).' });
        list.createEl('li', { text: 'Right-click a selection in the editor to link just that text/link vault-wide.' });
    }
}

// ---------- UI: Confirmation modal ----------

class ConfirmModal extends Modal {
    private title: string;
    private message: string;
    private onConfirm: () => void;

    constructor(app: App, title: string, message: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const buttonRow = contentEl.createDiv({ cls: 'auto-linker-modal-buttons' });

        const confirmBtn = buttonRow.createEl('button', { text: 'Continue', cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });

        const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}
