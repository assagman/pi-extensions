import type { Component, TUI } from "@mariozechner/pi-tui";
import { DiffService } from "../services/diff-service.js";

export class Dashboard implements Component {
  private files: string[] = [];
  private selectedIndex = 0;
  private diffContent = "Loading...";
  private diffService: DiffService;
  private scrollOffset = 0;

  constructor(
    private tui: TUI,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    private theme: any,
    // biome-ignore lint/suspicious/noExplicitAny: Keybindings type not exported
    private keybindings: any,
    // biome-ignore lint/suspicious/noExplicitAny: Callback result type varies
    private done: (result: any) => void
  ) {
    this.diffService = new DiffService();
    this.init();
  }

  async init() {
    try {
      this.files = await this.diffService.getFiles();
      if (this.files.length > 0) {
        this.selectFile(0);
      } else {
        this.diffContent = "No changes found.";
        this.refresh();
      }
    } catch (_e) {
      this.diffContent = "Error loading files.";
      this.refresh();
    }
  }

  async selectFile(index: number) {
    this.selectedIndex = index;
    const file = this.files[index];
    this.diffContent = `Loading diff for ${file}...`;
    this.refresh();

    try {
      const { raw } = await this.diffService.getDiff(undefined, undefined, file);
      this.diffContent = raw || "No changes in file.";
    } catch (_e) {
      this.diffContent = "Error loading diff.";
    }
    this.scrollOffset = 0;
    this.refresh();
  }

  invalidate() {
    // No internal cache to clear, relying on render() to generate fresh lines
  }

  private refresh() {
    this.tui.requestRender();
  }

  handleInput(key: string) {
    if (key === "q" || key === "escape") {
      this.done(null);
      return;
    }
    if (key === "down" || key === "j") {
      if (this.files.length > 0) {
        const next = (this.selectedIndex + 1) % this.files.length;
        this.selectFile(next);
      }
      return;
    }
    if (key === "up" || key === "k") {
      if (this.files.length > 0) {
        const prev = (this.selectedIndex - 1 + this.files.length) % this.files.length;
        this.selectFile(prev);
      }
      return;
    }
  }

  render(width: number): string[] {
    const sidebarWidth = Math.min(30, Math.floor(width * 0.3));
    const diffWidth = Math.max(10, width - sidebarWidth - 3);

    const lines: string[] = [];

    // Header
    const title = " Theta Code Review ";
    lines.push(this.theme.bg("selectedBg", this.theme.fg("text", title.padEnd(width))));

    // Prepare file list
    const fileLines = this.files.map((f, i) => {
      const selected = i === this.selectedIndex;
      const prefix = selected ? "> " : "  ";
      let name = f;
      if (name.length > sidebarWidth - 4) {
        name = `...${name.slice(-(sidebarWidth - 7))}`;
      }
      const text = (prefix + name).padEnd(sidebarWidth);
      return selected ? this.theme.fg("accent", text) : this.theme.fg("text", text);
    });

    // Prepare diff content
    const diffLinesRaw = this.diffContent.split("\n");
    const diffViewLines = diffLinesRaw.map((l) => {
      let styled = l;
      if (l.length > diffWidth) {
        styled = l.slice(0, diffWidth);
      }

      if (l.startsWith("+")) return this.theme.fg("success", styled);
      if (l.startsWith("-")) return this.theme.fg("error", styled);
      if (l.startsWith("@")) return this.theme.fg("accent", styled);
      return this.theme.fg("text", styled);
    });

    const contentHeight = Math.max(fileLines.length, diffViewLines.length, 20);

    for (let i = 0; i < contentHeight; i++) {
      const left = fileLines[i] || "".padEnd(sidebarWidth);
      const right = diffViewLines[i] || "";
      const separator = this.theme.fg("dim", " │ ");
      lines.push(left + separator + right);
    }

    lines.push(this.theme.fg("dim", " [j/k] Navigate  [q] Quit"));

    return lines;
  }
}
