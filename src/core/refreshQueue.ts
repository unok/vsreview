export class RefreshQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private ready = false;
  private disposed = false;
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly delay: number,
  ) {}
  request(): void {
    if (this.disposed) {
      return;
    }
    clearTimeout(this.timer);
    this.ready = false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ready = true;
      void this.drain();
    }, this.delay);
  }
  private async drain(): Promise<void> {
    if (this.running || this.disposed || !this.ready) {
      return;
    }
    this.running = true;
    this.ready = false;
    try {
      await this.refresh();
    } catch (error) {
      this.failed(error);
    } finally {
      this.running = false;
      void this.drain();
    }
  }
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ready = false;
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
