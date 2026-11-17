export const VOICE_POLL_AUDIO_LIMIT_MS = 15_000;
export interface VoiceAnnouncement { id: string; guildId: string; voiceChannelId: string }
export interface VoiceAnnouncementSession {
  ready: Promise<void>;
  play(): void;
  close(): void;
}
export interface VoiceAnnouncementDriver {
  open(request: VoiceAnnouncement, signal: AbortSignal, ended: (failed?: boolean) => void): Promise<VoiceAnnouncementSession | null>;
}
interface Playback {
  request: VoiceAnnouncement; controller: AbortController; timer: ReturnType<typeof setTimeout>;
  session?: VoiceAnnouncementSession;
}
/** Best-effort side effect, independent of money, publication and deadline jobs. */
export class VoicePollAudio {
  private current: Playback | undefined;
  private stopped = false;
  private seen = new Set<string>();
  constructor(private readonly driver: VoiceAnnouncementDriver,
    private readonly warn = () => console.warn('Voice vote audio unavailable; voting continues normally.')) {}
  play(request: VoiceAnnouncement): void {
    if (this.stopped || this.seen.has(request.id)) return;
    this.seen.add(request.id);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    // A bot can occupy only one room in this configured guild. A fresh vote
    // preempts the previous announcement rather than queueing stale music.
    if (this.current) this.finish(this.current);
    const controller = new AbortController();
    const run: Playback = { request, controller,
      timer: setTimeout(() => this.finish(run), VOICE_POLL_AUDIO_LIMIT_MS) };
    run.timer.unref(); this.current = run;
    void this.start(run);
  }
  private async start(run: Playback): Promise<void> {
    try {
      const session = await this.driver.open(run.request, run.controller.signal, failed => this.finish(run, failed));
      if (this.current !== run) {
        if (session) { void session.ready.catch(() => {}); session.close(); }
        return;
      }
      if (!session) { this.finish(run, true); return; }
      run.session = session;
      await session.ready;
      if (this.current === run) session.play();
    } catch { this.finish(run, true); }
  }
  private finish(run: Playback, failed = false): void {
    if (this.current !== run) return;
    this.current = undefined;
    clearTimeout(run.timer); run.controller.abort();
    try { run.session?.close(); } catch { failed = true; }
    if (failed) this.warn();
  }
  stop(): void {
    this.stopped = true;
    if (this.current) this.finish(this.current);
    this.seen.clear();
  }
}
