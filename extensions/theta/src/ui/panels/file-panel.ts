import { visibleWidth } from "@mariozechner/pi-tui";
import type { DiffFile } from "../../services/diff-service.js";
import { padToWidth, truncateStartToWidth } from "../text-utils.js";
import type { Panel, PanelComponent } from "../types.js";

export class FilePanel implements PanelComponent {
  files: DiffFile[] = [];
  filteredFiles: DiffFile[] = [];
  matchIndices: number[] = [];
  index = 0;
  scrollOffset = 0;
  isFiltered = false;

  get filterMatchCount(): number {
    return this.isFiltered ? this.filteredFiles.length : 0;
  }

  get filterCurrentIndex(): number {
    return this.index;
  }

  applyFilter(query: string, caseSensitive: boolean): void {
    if (!query) {
      this.filteredFiles = this.files;
      this.matchIndices = [];
      this.isFiltered = false;
      return;
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    this.filteredFiles = [];
    this.matchIndices = [];

    for (let idx = 0; idx < this.files.length; idx++) {
      const file = this.files[idx];
      const path = caseSensitive ? file.path : file.path.toLowerCase();

      if (path.includes(needle)) {
        this.matchIndices.push(this.filteredFiles.length);
        this.filteredFiles.push(file);
      }
    }
    this.isFiltered = true;
  }

  clearFilter(): void {
    this.filteredFiles = this.files;
    this.matchIndices = [];
    this.isFiltered = false;
    this.index = 0;
    this.scrollOffset = 0;
  }

  getDisplayFiles(): DiffFile[] {
    return this.isFiltered ? this.filteredFiles : this.files;
  }

  render(
    width: number,
    contentHeight: number,
    activePanel: Panel,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    const lines: string[] = [];
    const visibleCount = contentHeight;

    // Adjust scroll to keep selection visible
    if (this.index < this.scrollOffset) {
      this.scrollOffset = this.index;
    } else if (this.index >= this.scrollOffset + visibleCount) {
      this.scrollOffset = this.index - visibleCount + 1;
    }

    const displayFiles = this.getDisplayFiles();
    const visible = displayFiles.slice(this.scrollOffset, this.scrollOffset + visibleCount);

    for (let i = 0; i < visible.length; i++) {
      const file = visible[i];
      const realIndex = this.scrollOffset + i;
      const selected = realIndex === this.index;
      const focused = activePanel === "files";

      const prefix = selected ? "▸ " : "  ";
      const statsRaw = `+${file.additions} -${file.deletions} `;
      const maxName = Math.max(0, width - visibleWidth(prefix) - visibleWidth(statsRaw));
      const name = truncateStartToWidth(file.path, maxName);

      const statsStyled = `${
        theme.fg("success", `+${file.additions}`) + theme.fg("error", ` -${file.deletions}`)
      } `;

      let nameStyled: string;
      if (selected && focused) {
        nameStyled = theme.fg("accent", name);
      } else if (selected) {
        nameStyled = theme.fg("accent", name);
      } else {
        nameStyled = theme.fg("text", name);
      }

      const prefixStyled = selected ? theme.fg("accent", prefix) : theme.fg("dim", prefix);

      let line = padToWidth(prefixStyled + statsStyled + nameStyled, width);

      if (selected && focused) {
        line = theme.bg("selectedBg", line);
      }

      lines.push(line);
    }

    return lines;
  }
}
