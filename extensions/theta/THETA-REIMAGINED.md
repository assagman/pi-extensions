# Theta Reimagined: Ground-Up Rewrite Plan

## Executive Summary

Rewrite Theta's TUI layer to achieve **tmux-like scrolling performance** by eliminating abstraction overhead and using direct terminal control with hardware-accelerated scrolling.

---

## Current Architecture Problems

### 1. Layered Rendering Pipeline

```
User Input
    ↓
Dashboard.render()          ← Builds string[] for 3 panels
    ↓
DimmedOverlay.render()      ← Composites scrim + stars + glow + dialog
    ↓
TUI.requestRender()         ← Framework diffs output
    ↓
Terminal Write              ← Full screen update
```

**Every keystroke triggers the entire pipeline**, even for a 1-line scroll.

### 2. String-Based Rendering

Each frame:
- Allocates new `string[]` arrays
- Builds ANSI escape sequences via `theme.fg()`, `theme.bg()`
- Concatenates strings with `+` operator
- Calls `visibleWidth()` which parses ANSI codes

### 3. Overlay Overhead

DimmedOverlay does per-frame:
- Star field lookup and rendering
- Scrim row generation
- Glow halo compositing
- Dialog positioning math

At 96% width / 94% height, the scrim is barely visible—yet we pay full cost.

### 4. No Dirty Region Tracking

All 3 panels re-render on any input, even if only the diff panel scrolled.

### 5. TUI Framework Abstraction

pi-tui's `requestRender()` → internal diff → write cycle adds latency and prevents fine-grained control.

---

## New Architecture: Direct Terminal Control

### Core Principles

1. **No intermediate string arrays** — Write directly to terminal
2. **Cursor-addressed updates** — Only update changed lines
3. **Hardware scroll regions** — Let terminal handle scrolling
4. **Pre-rendered line cache** — Cache styled lines, not regenerate
5. **Dirty tracking** — Track exactly what changed

### Terminal Control Primitives

```ts
// Cursor positioning
const moveTo = (row: number, col: number) => `\x1b[${row};${col}H`;

// Scroll region (hardware accelerated)
const setScrollRegion = (top: number, bottom: number) => `\x1b[${top};${bottom}r`;
const scrollUp = (n: number) => `\x1b[${n}S`;
const scrollDown = (n: number) => `\x1b[${n}T`;
const resetScrollRegion = () => `\x1b[r`;

// Screen control
const enterAltScreen = () => `\x1b[?1049h`;
const exitAltScreen = () => `\x1b[?1049l`;
const hideCursor = () => `\x1b[?25l`;
const showCursor = () => `\x1b[?25h`;
const clearScreen = () => `\x1b[2J`;
```

### Rendering Strategy

#### Hardware Scroll Regions

tmux achieves smooth scrolling by using **ANSI scroll regions**:

```ts
// Set scroll region to diff panel area (rows 2-40)
terminal.write(`\x1b[2;40r`);

// Scroll down by 1 (hardware accelerated - terminal shifts pixels)
terminal.write(`\x1b[1S`);

// Render only the new bottom line
terminal.write(`\x1b[40;1H${newLine}`);

// Reset scroll region
terminal.write(`\x1b[r`);
```

This is **orders of magnitude faster** than redrawing the entire viewport.

#### Cursor-Addressed Updates

Instead of returning `string[]` for the framework to diff:

```ts
// Bad: Current approach
render(): string[] {
  const lines = [];
  for (let i = 0; i < height; i++) {
    lines.push(this.renderLine(i));
  }
  return lines;
}

// Good: Direct terminal writes
scrollDown(): void {
  // Hardware scroll
  this.terminal.write(`\x1b[${this.top};${this.bottom}r\x1b[1S\x1b[r`);
  
  // Render only the new line
  const newLineIdx = this.scrollOffset + this.height - 1;
  const content = this.lineCache.get(newLineIdx) ?? this.renderLine(newLineIdx);
  this.terminal.write(`\x1b[${this.bottom};${this.left}H${content}`);
}
```

---

## Proposed Architecture

### File Structure

```
extensions/theta/
├── src/
│   ├── index.ts                 # Extension entry point
│   ├── terminal/
│   │   ├── terminal-writer.ts   # Direct terminal control
│   │   ├── scroll-region.ts     # Hardware scroll region management
│   │   ├── screen-buffer.ts     # Virtual screen buffer for dirty tracking
│   │   └── ansi.ts              # ANSI escape code constants
│   ├── ui/
│   │   ├── app.ts               # Main application controller
│   │   ├── layout.ts            # Panel layout calculator
│   │   ├── line-cache.ts        # Pre-rendered line cache
│   │   └── panels/
│   │       ├── base-panel.ts    # Base panel with scroll region support
│   │       ├── commit-panel.ts  # Commit list
│   │       ├── file-panel.ts    # File list
│   │       └── diff-panel.ts    # Diff viewer
│   ├── services/
│   │   └── diff-service.ts      # Git diff fetching (keep existing)
│   └── input/
│       └── key-handler.ts       # Input processing
```

### Core Components

#### 1. TerminalWriter

Low-level terminal control without framework overhead:

```ts
export class TerminalWriter {
  constructor(private stream: NodeJS.WriteStream) {}

  write(data: string): void {
    this.stream.write(data);
  }

  moveTo(row: number, col: number): void {
    this.write(`\x1b[${row};${col}H`);
  }

  writeLine(row: number, col: number, content: string): void {
    this.write(`\x1b[${row};${col}H${content}`);
  }

  setScrollRegion(top: number, bottom: number): void {
    this.write(`\x1b[${top};${bottom}r`);
  }

  scrollUp(lines = 1): void {
    this.write(`\x1b[${lines}S`);
  }

  scrollDown(lines = 1): void {
    this.write(`\x1b[${lines}T`);
  }

  resetScrollRegion(): void {
    this.write('\x1b[r');
  }

  enterAltScreen(): void {
    this.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  }

  exitAltScreen(): void {
    this.write('\x1b[?1049l\x1b[?25h');
  }
}
```

#### 2. ScrollRegion

Manages a scrollable viewport with hardware acceleration:

```ts
export class ScrollRegion {
  private scrollOffset = 0;
  
  constructor(
    private writer: TerminalWriter,
    private top: number,      // First row (1-indexed)
    private bottom: number,   // Last row (1-indexed)
    private left: number,     // First column (1-indexed)
    private width: number,
    private totalLines: number,
    private renderLine: (index: number) => string
  ) {}

  get height(): number {
    return this.bottom - this.top + 1;
  }

  scrollDownBy(n: number): void {
    const maxScroll = Math.max(0, this.totalLines - this.height);
    const newOffset = Math.min(this.scrollOffset + n, maxScroll);
    const delta = newOffset - this.scrollOffset;
    
    if (delta === 0) return;
    
    this.scrollOffset = newOffset;

    if (delta === 1) {
      // Hardware scroll: shift viewport up, render new bottom line
      this.writer.setScrollRegion(this.top, this.bottom);
      this.writer.scrollUp(1);
      this.writer.resetScrollRegion();
      
      const lineIdx = this.scrollOffset + this.height - 1;
      this.writer.writeLine(this.bottom, this.left, this.renderLine(lineIdx));
    } else {
      // Large jump: full redraw
      this.fullRedraw();
    }
  }

  scrollUpBy(n: number): void {
    const newOffset = Math.max(0, this.scrollOffset - n);
    const delta = this.scrollOffset - newOffset;
    
    if (delta === 0) return;
    
    this.scrollOffset = newOffset;

    if (delta === 1) {
      // Hardware scroll: shift viewport down, render new top line
      this.writer.setScrollRegion(this.top, this.bottom);
      this.writer.scrollDown(1);
      this.writer.resetScrollRegion();
      
      this.writer.writeLine(this.top, this.left, this.renderLine(this.scrollOffset));
    } else {
      // Large jump: full redraw
      this.fullRedraw();
    }
  }

  fullRedraw(): void {
    for (let i = 0; i < this.height; i++) {
      const lineIdx = this.scrollOffset + i;
      const content = lineIdx < this.totalLines 
        ? this.renderLine(lineIdx) 
        : ' '.repeat(this.width);
      this.writer.writeLine(this.top + i, this.left, content);
    }
  }
}
```

#### 3. LineCache

Pre-rendered line storage to avoid regenerating styled lines:

```ts
export class LineCache {
  private cache = new Map<string, string>();
  private version = 0;

  constructor(private maxSize = 10000) {}

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entries
      const keysToDelete = Array.from(this.cache.keys()).slice(0, 1000);
      for (const k of keysToDelete) {
        this.cache.delete(k);
      }
    }
    this.cache.set(key, value);
  }

  invalidate(): void {
    this.cache.clear();
    this.version++;
  }

  getVersion(): number {
    return this.version;
  }
}
```

#### 4. DiffPanel (Reimagined)

```ts
export class DiffPanel {
  private scrollRegion: ScrollRegion;
  private lineCache: LineCache;
  private rawLines: string[] = [];
  private styledLines: string[] = [];

  constructor(
    private writer: TerminalWriter,
    private top: number,
    private bottom: number,
    private left: number,
    private width: number
  ) {
    this.lineCache = new LineCache();
    this.scrollRegion = new ScrollRegion(
      writer,
      top,
      bottom,
      left,
      width,
      0,
      (idx) => this.getStyledLine(idx)
    );
  }

  setContent(content: string): void {
    this.rawLines = content.split('\n');
    this.styledLines = [];
    this.lineCache.invalidate();
    
    // Pre-style all lines (or do lazily)
    for (let i = 0; i < this.rawLines.length; i++) {
      this.styledLines[i] = this.styleLine(this.rawLines[i]);
    }
    
    this.scrollRegion = new ScrollRegion(
      this.writer,
      this.top,
      this.bottom,
      this.left,
      this.width,
      this.styledLines.length,
      (idx) => this.getStyledLine(idx)
    );
    
    this.scrollRegion.fullRedraw();
  }

  private styleLine(raw: string): string {
    // Simple, fast styling without framework overhead
    const prefix = raw[0];
    let color: string;
    
    if (prefix === '+') color = '\x1b[32m';      // Green
    else if (prefix === '-') color = '\x1b[31m'; // Red
    else if (prefix === '@') color = '\x1b[36m'; // Cyan
    else color = '\x1b[0m';                      // Default
    
    const truncated = raw.length > this.width 
      ? raw.slice(0, this.width) 
      : raw.padEnd(this.width);
    
    return `${color}${truncated}\x1b[0m`;
  }

  private getStyledLine(index: number): string {
    if (index >= this.styledLines.length) {
      return ' '.repeat(this.width);
    }
    return this.styledLines[index];
  }

  scrollDown(): void {
    this.scrollRegion.scrollDownBy(1);
  }

  scrollUp(): void {
    this.scrollRegion.scrollUpBy(1);
  }

  pageDown(): void {
    this.scrollRegion.scrollDownBy(Math.floor(this.scrollRegion.height / 2));
  }

  pageUp(): void {
    this.scrollRegion.scrollUpBy(Math.floor(this.scrollRegion.height / 2));
  }
}
```

#### 5. App Controller

```ts
export class App {
  private writer: TerminalWriter;
  private commitPanel: CommitPanel;
  private filePanel: FilePanel;
  private diffPanel: DiffPanel;
  private activePanel: 'commits' | 'files' | 'diff' = 'commits';
  private running = true;

  constructor(private stdin: NodeJS.ReadStream, private stdout: NodeJS.WriteStream) {
    this.writer = new TerminalWriter(stdout);
    
    const { rows, columns } = stdout;
    const layout = this.calculateLayout(columns, rows);
    
    this.commitPanel = new CommitPanel(this.writer, layout.commits);
    this.filePanel = new FilePanel(this.writer, layout.files);
    this.diffPanel = new DiffPanel(
      this.writer,
      layout.diff.top,
      layout.diff.bottom,
      layout.diff.left,
      layout.diff.width
    );
  }

  async run(): Promise<void> {
    this.writer.enterAltScreen();
    this.drawChrome();
    
    // Raw mode for immediate key handling
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    
    await this.init();
    
    for await (const key of this.stdin) {
      if (!this.running) break;
      this.handleKey(key);
    }
    
    this.writer.exitAltScreen();
  }

  private handleKey(key: string): void {
    if (key === 'q' || key === '\x1b') {
      this.running = false;
      return;
    }

    if (this.activePanel === 'diff') {
      switch (key) {
        case 'j':
        case '\x1b[B': // Down arrow
          this.diffPanel.scrollDown();
          break;
        case 'k':
        case '\x1b[A': // Up arrow
          this.diffPanel.scrollUp();
          break;
        case '\x04': // Ctrl+D
          this.diffPanel.pageDown();
          break;
        case '\x15': // Ctrl+U
          this.diffPanel.pageUp();
          break;
      }
    }
    
    // Panel switching
    if (key === 'h') this.switchPanelLeft();
    if (key === 'l') this.switchPanelRight();
  }

  private drawChrome(): void {
    // Draw static elements: headers, borders
    // These never change during scrolling
  }

  private calculateLayout(cols: number, rows: number) {
    const commitWidth = Math.floor(cols * 0.2);
    const fileWidth = Math.floor(cols * 0.2);
    const diffWidth = cols - commitWidth - fileWidth - 2;
    
    return {
      commits: { top: 2, bottom: rows - 2, left: 1, width: commitWidth },
      files: { top: 2, bottom: rows - 2, left: commitWidth + 2, width: fileWidth },
      diff: { top: 2, bottom: rows - 2, left: commitWidth + fileWidth + 3, width: diffWidth },
    };
  }
}
```

---

## Performance Comparison

| Operation | Current | Reimagined |
|-----------|---------|------------|
| Scroll 1 line | ~50-100 string ops + full TUI diff | 1 ANSI sequence + 1 line render |
| Page scroll | O(contentHeight) renders | O(contentHeight) renders (unavoidable) |
| Panel switch | Full redraw | Cursor move + highlight change |
| Content load | Full redraw | Full redraw (unavoidable) |
| Memory | New arrays every frame | Cached styled lines |

### Why Hardware Scrolling is Fast

When you send `\x1b[1S` (scroll up 1 line):
1. Terminal **shifts existing pixels/cells** in video memory
2. Only the new line needs to be drawn
3. No string processing, no diffing, no framework overhead

This is why tmux copy-mode feels instant — it uses the same technique.

---

## Migration Path

### Phase 1: Bypass DimmedOverlay (Quick Win)
- Render Dashboard directly to alt-screen
- Remove scrim/stars/glow overhead
- Keep existing panel rendering

### Phase 2: Direct Terminal Writes
- Replace `render(): string[]` with direct writes
- Add cursor positioning

### Phase 3: Hardware Scroll Regions
- Implement ScrollRegion class
- Wire up diff panel scrolling

### Phase 4: Line Caching
- Pre-render styled lines on content load
- Cache lookup instead of regeneration

### Phase 5: Optimize Other Panels
- Apply same techniques to commit/file panels
- Add dirty tracking for selective updates

---

## Risks and Mitigations

### Terminal Compatibility
**Risk**: Some terminals may not support scroll regions properly.
**Mitigation**: Feature detection, fallback to full redraw.

### Complexity
**Risk**: Direct terminal control is more error-prone.
**Mitigation**: Encapsulate in well-tested primitives (TerminalWriter, ScrollRegion).

### Integration with Pi
**Risk**: Bypassing pi-tui may break other Pi features.
**Mitigation**: Use pi-tui's `terminal.write()` for raw access, maintain proper lifecycle.

---

## Success Criteria

1. **Scrolling feels instant** — No perceptible delay on j/k
2. **No visual artifacts** — Clean updates, no tearing
3. **Memory stable** — No growth during extended use
4. **CPU minimal** — Near-zero CPU during idle, minimal during scroll

---

## References

- [ANSI Escape Codes](https://en.wikipedia.org/wiki/ANSI_escape_code)
- [XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
- [tmux source - screen.c](https://github.com/tmux/tmux/blob/master/screen.c)
- [Terminal Scroll Regions](https://vt100.net/docs/vt100-ug/chapter3.html#S3.5)
