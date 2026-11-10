// The dependency ships no types. Describe only the API used by this bot.
declare module 'media-downloader-ez' {
  function MediaDownloader(url: string, options?: { autocrop?: boolean }): Promise<string>;

  namespace MediaDownloader {
    function isVideoLink(url: string): boolean;
  }

  export = MediaDownloader;
}
