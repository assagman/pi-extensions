import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export class DiffPanel {
  content = "Loading...";
  scrollOffset = 0;
  maxLines = 0;

  render(
    width: number,
    contentHeight: number,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    const rawLines = this.content.split("\n");
    this.maxLines = rawLines.length;

    const visible = rawLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

    return visible.map((l) => {
      const truncated = visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l;

      if (l.startsWith("+")) return theme.fg("success", truncated);
      if (l.startsWith("-")) return theme.fg("error", truncated);
      if (l.startsWith("@@")) return theme.fg("accent", truncated);
      if (l.startsWith("diff ") || l.startsWith("index ")) return theme.fg("dim", truncated);
      return theme.fg("text", truncated);
    });
  }
}
