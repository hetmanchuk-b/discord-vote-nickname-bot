export function formatVoiceTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 3600)} год ${Math.floor(seconds / 60) % 60} хв ${seconds % 60} с`;
}
