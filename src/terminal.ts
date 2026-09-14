/** Only valid Tidal source reaches the terminal. No UI labels or status prose. */
export class CodeTerminal {
  private queue: { source: string; setup: boolean; seconds?: number }[] = [];
  private hits: { line: HTMLSpanElement; remaining: string; carry: number; rate: number }[] = [];
  private line: HTMLSpanElement | null = null;
  private remaining = '';
  private carry = 0;
  private paused = false;
  private typingSeconds = 2.5;
  private characterRate = 110;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly code: HTMLElement, private readonly panel: HTMLElement) {}

  append(source: string, setup = false, seconds?: number) {
    this.queue.push({ source, setup, seconds });
  }

  appendHit(source: string) {
    const line = this.addLine(false);
    this.hits.push({ line, remaining: source + '\n', carry: 0, rate: source.length / .12 });
  }

  private addLine(setup: boolean) {
    this.code.querySelector('.newest')?.classList.remove('newest');
    const line = document.createElement('span');
    line.className = `code-line newest${setup ? ' setup' : ''}`;
    this.code.append(line);
    while (this.code.childElementCount > 240) this.code.firstElementChild?.remove();
    return line;
  }

  setPaused(paused: boolean) { this.paused = paused; }
  setBpm(bpm: number) { this.typingSeconds = 480 / bpm * .72; }

  update(delta: number) {
    if (this.paused) return;
    for (const hit of this.hits) {
      hit.carry += delta * hit.rate;
      const count = this.reduced ? hit.remaining.length : Math.floor(hit.carry);
      const nearBottom = this.panel.scrollHeight - this.panel.scrollTop - this.panel.clientHeight < 70;
      hit.line.textContent += hit.remaining.slice(0, count);
      hit.remaining = hit.remaining.slice(count);
      hit.carry -= count;
      if (nearBottom) this.panel.scrollTop = this.panel.scrollHeight;
    }
    this.hits = this.hits.filter(hit => hit.remaining);
    if (!this.remaining && this.queue.length) {
      const item = this.queue.shift()!;
      this.line = this.addLine(item.setup);
      this.remaining = item.source + '\n';
      this.characterRate = Math.max(110, this.remaining.length / (item.seconds ?? this.typingSeconds));
      this.carry = 0;
    }
    if (!this.remaining || !this.line) return;
    // Phrases finish within a two-cycle window, even with dense polyphony.
    this.carry += delta * this.characterRate;
    const count = this.reduced ? this.remaining.length : Math.floor(this.carry);
    if (count < 1) return;
    const nearBottom = this.panel.scrollHeight - this.panel.scrollTop - this.panel.clientHeight < 70;
    this.line.textContent += this.remaining.slice(0, count);
    this.remaining = this.remaining.slice(count);
    this.carry -= count;
    if (nearBottom) this.panel.scrollTop = this.panel.scrollHeight;
  }

  reset() {
    this.queue = [];
    this.hits = [];
    this.line = null;
    this.remaining = '';
    this.carry = 0;
    this.paused = false;
    this.code.replaceChildren();
    this.panel.scrollTop = 0;
    this.panel.scrollLeft = 0;
  }
}
