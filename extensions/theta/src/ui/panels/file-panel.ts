import { visibleWidth } from "@mariozechner/pi-tui";
import type { DiffFile } from "../../services/diff-service.js";
import { padToWidth, truncateStartToWidth } from "../text-utils.js";
import type { Panel } from "../types.js";

export class FilePanel {
  files: DiffFile[] = [];
  index = 0;
  scrollOffset = 0;

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

    const visible = this.files.slice(this.scrollOffset, this.scrollOffset + visibleCount);

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
